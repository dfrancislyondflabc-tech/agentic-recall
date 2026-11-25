// MEM-111 — EMBEDDING MUST NEVER SWELL MEMORY.
//
// THE BUG (2026-11-24, the author's 16 GB Mac, 27 GB into swap, "computer mostly unresponsive"): embedBatched sent 16
// texts per forward pass in ARRIVAL order. The ONNX runtime keeps the memory of the largest pass it has run, and a pass
// costs (texts) × (longest text) — one long chunk padded fifteen short ones to 512 tokens. A capture process was seen
// at 1.9 GB 22 s after it started. The same engine in the Email Backup app (EB-473): 2 long texts per pass = 0.76 GB
// and the fastest; 8 = 2.1 GB; 64 = >4.7 GB in two passes.
//
// THE FIX (lib/embed.js): sort by length, memory-bounded passes, the caller's order restored; passage embedding waits
// while macOS memory pressure is not normal (queries never wait).
// This proves: the pass rule (with a control that the old split breaks it), the order is restored (each vector is its own
// text's), the pressure wait holds indexing and not queries, and — in a child process on the real
// model — 240 long chunks keep the process under 1.2 GB.
import { spawnSync } from 'node:child_process';
import { stopChild } from './sandbox-cleanup.mjs';   // repo rule: tests that spawn import the cleanup helper (spawnSync + timeout ends its child itself)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const words = (n, seed = 0) => Array.from({ length: n }, (_, i) => 'term' + ((i * 7 + seed) % 97)).join(' ');

export async function embedMemoryTests({ check, group }) {
  group('MEM-111 — embedding never swells memory (memory-bounded passes, waits under memory pressure)');
  const E = await import(join(ROOT, 'lib', 'embed.js'));
  const cost = (p) => p.length * Math.min(Math.max(...p.map((x) => x.text.length)), E.MODEL_READS_CHARS);

  const mix = [...Array(120)].map((_, i) => ({ id: i, text: i % 3 ? words(8, i) : words(450, i) })).sort((a, b) => a.text.length - b.text.length);
  const passes = E.memoryBoundedPasses(mix);
  check('every text is in exactly one pass, in order', passes.flat().length === mix.length && passes.flat().every((x, i) => x === mix[i]));
  check('no pass is over the memory budget', passes.every((p) => cost(p) <= E.PASS_CHAR_BUDGET || p.length === 1), JSON.stringify(passes.map(cost)));
  check('texts at the model reading limit go at most 2 per pass', passes.filter((p) => p.some((x) => x.text.length >= E.MODEL_READS_CHARS)).every((p) => p.length <= 2));
  const old = []; for (let i = 0; i < 120; i += 16) old.push(mix.slice(i, i + 16));
  check('control: the old 16-per-pass split IS over budget on the same texts', old.some((p) => cost(p) > E.PASS_CHAR_BUDGET));

  if (!(await E.embeddingsAvailable())) { check('embedding model available for the real checks (skipped: BM25-only install)', true); return; }

  // order + identical vectors
  const texts = [words(450, 1), 'short one', words(60, 2), 'another short', words(300, 3)];
  const together = await E.embedPassages(texts);
  const single = []; for (const t of texts) single.push((await E.embedPassages([t]))[0]);
  // The quantized model's vectors shift slightly with their pass-mates (dynamic int8 ranges span the whole pass) — that
  // was already true of the old 16-in-arrival-order passes. What must hold: each vector is ITS text's (order restored).
  const own = together.map((v, i) => single.map((u) => E.cosine(v, u)).reduce((b, c, j, a) => (c > a[b] ? j : b), 0) === i);
  const cos = together.map((v, i) => E.cosine(v, single[i]));
  check('the caller\'s order is restored: every vector is closest to its OWN text\'s one-at-a-time vector (and > 0.98)', together.length === texts.length && own.every(Boolean) && cos.every((c) => c > 0.98), cos.map((c) => c.toFixed(4)).join(','));

  // pressure wait: indexing waits, queries do not
  let calls = 0; E._setPressureProbeForTest(async () => (++calls <= 1 ? 2 : 1));
  const t0 = Date.now(); await E.embedPassages(['wait for memory please']); const waited = Date.now() - t0;
  check('passage embedding WAITS while memory pressure is not normal, then goes on', calls >= 2 && waited >= 4000, `probe calls ${calls}, waited ${waited} ms`);
  calls = 0; E._setPressureProbeForTest(async () => { calls++; return 4; });
  const t1 = Date.now(); await E.embedQuery('a question'); const qms = Date.now() - t1;
  check('a QUERY never waits on memory pressure (the user is waiting for it)', calls === 0 && qms < 4000, `probe calls ${calls}, ${qms} ms`);
  E._setPressureProbeForTest(null);

  // real footprint, in a child process (footprint is macOS-only)
  if (process.platform === 'darwin') {
    const code = `import { embedPassages } from ${JSON.stringify(join(ROOT, 'lib', 'embed.js'))};
      import { execSync } from 'node:child_process';
      const w = (n, s) => Array.from({ length: n }, (_, i) => 'term' + ((i * 7 + s) % 97)).join(' ');
      const fp = () => Number((execSync('footprint ' + process.pid + ' 2>/dev/null | head -2').toString().match(/Footprint: (\\d+)/) || [0, -1])[1]);
      let peak = 0;
      for (let b = 0; b < 15; b++) { await embedPassages(Array.from({ length: 16 }, (_, i) => (i % 4 ? w(20, b * 16 + i) : w(450, b * 16 + i)))); peak = Math.max(peak, fp()); }
      console.log('PEAK ' + peak);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 300000 });
    const peak = Number(((r.stdout || '').match(/PEAK (\d+)/) || [0, -1])[1]);
    check('real model, 240 chunks (a quarter at the 512-token limit, mixed with short ones): process footprint under 1.2 GB', peak > 0 && peak < 1200, `peak ${peak} MB ${(r.stderr || '').slice(-200)}`);
  }
}
