// MEM-113 — A STAGING SEARCH MUST NOT READ WHOLE TRANSCRIPTS.
//
// THE BUG (2026-11-25, the author's 16 GB Mac): every staging search asks lib/capture-status.js which conversations
// are not yet captured, and that asks lib/capturable.js whether each transcript touched in the last 7 days is a
// scheduled task. The answer needs the first 64 KB; the code read the WHOLE file and sliced it. Claude Code
// transcripts there reach 1.2 GB. Measured, one search on the real machine: footprint 1,410 -> 5,134 MB from that one
// call, held at 4.2 GB afterwards (macOS does not take the pages back) — in every connector copy that searched.
// After the fix: the same search peaks at 1,639 MB and settles at 1,416 MB (the index itself).
//
// This proves: readHead returns exactly what the whole-file read returned (multi-byte text, a file shorter than the
// head, an empty file); the scheduled-task decision is unchanged; and — in a child process — deciding a 400 MB
// transcript costs a few MB, with a control showing the old read of the same file costs hundreds.
import { spawnSync } from 'node:child_process';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';   // repo rule: tests that spawn import the cleanup helper (spawnSync ends its own child)
import { mkdtempSync, writeFileSync, truncateSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const line = (o) => JSON.stringify(o) + '\n';

export async function readHeadMemoryTests({ check, group }) {
  group('MEM-113 — a staging search never reads a whole transcript (head-only read)');
  const { readHead, fileLines } = await import(join(ROOT, 'lib', 'read-head.js'));
  const { excludedSessionReason, forgetCapturable } = await import(join(ROOT, 'lib', 'capturable.js'));
  const dir = mkdtempSync(join(tmpdir(), 'mem113-'));
  try {
    // identical output to the whole-file read, including 2-, 3- and 4-byte characters across the edge
    const multi = join(dir, 'multi.txt');
    const body = ('é漢字🙂abc'.repeat(30000));
    writeFileSync(multi, body);
    for (const n of [1, 7, 4096, 65536, 200000]) {
      check(`readHead(${n}) === readFileSync().slice(0, ${n}) on multi-byte text`, readHead(multi, n) === readFileSync(multi, 'utf8').slice(0, n));
    }
    const tiny = join(dir, 'tiny.txt'); writeFileSync(tiny, 'short');
    const empty = join(dir, 'empty.txt'); writeFileSync(empty, '');
    check('a file shorter than the head comes back whole; an empty file comes back empty', readHead(tiny, 65536) === 'short' && readHead(empty, 65536) === '');

    // MEM-114: fileLines yields exactly readFileSync(p,'utf8').split('\n') — tiny chunks force every boundary case
    // (a multi-byte character cut by a chunk edge, a line longer than a chunk, with and without a final newline)
    const cases = { trailing: 'a\né漢🙂b\n\nlong-' + 'x🙂'.repeat(50) + '\n', none: 'one\ntwo 漢字', blank: '\n\n', empty: '' };
    for (const [k, txt] of Object.entries(cases)) {
      const f = join(dir, `lines-${k}.txt`); writeFileSync(f, txt);
      const want = readFileSync(f, 'utf8').split('\n');
      const ok = [3, 5, 7, 64, 1 << 20].every((cb) => JSON.stringify([...fileLines(f, cb)]) === JSON.stringify(want));
      check(`MEM-114 fileLines === split('\\n') at every chunk size (${k})`, ok);
    }
    const early = join(dir, 'early.txt'); writeFileSync(early, 'first\nsecond\nthird');
    let firstOnly = null; for (const l of fileLines(early)) { firstOnly = l; break; }
    check('MEM-114 stopping early returns the first line (and closes the file)', firstOnly === 'first');
    // the decision is unchanged
    const task = join(dir, 'task.jsonl');
    writeFileSync(task, line({ type: 'user', message: { content: '<scheduled-task name="x">do it</scheduled-task>' } }) + line({ type: 'assistant' }));
    const conv = join(dir, 'conv.jsonl');
    writeFileSync(conv, line({ type: 'user', message: { content: [{ type: 'text', text: 'what is the price of the rack server?' }] } }));
    forgetCapturable();
    check('a scheduled-task transcript is still excluded; a conversation is not', excludedSessionReason(task) === 'scheduled-task' && excludedSessionReason(conv) === null);

    // memory: a 400 MB transcript (sparse — its first line is a real user turn, the rest zeros)
    const big = join(dir, 'big.jsonl');
    writeFileSync(big, line({ type: 'user', message: { content: '<scheduled-task name="big">x</scheduled-task>' } }));
    truncateSync(big, 400 * 1024 * 1024);
    const probe = (code) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 120000 });
      try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { return { error: (r.stderr || '').slice(-300) }; }
    };
    const fixed = probe(`const { excludedSessionReason } = await import(${JSON.stringify(join(ROOT, 'lib', 'capturable.js'))});
      const b = process.memoryUsage().rss; const why = excludedSessionReason(${JSON.stringify(big)});
      console.log(JSON.stringify({ why, grewMB: Math.round((process.memoryUsage().rss - b) / 1048576) }));`);
    check('deciding a 400 MB transcript reads its head only: the process grows < 40 MB, and the decision is right', fixed.why === 'scheduled-task' && fixed.grewMB < 40, JSON.stringify(fixed));
    const old = probe(`const { readFileSync } = await import('node:fs');
      const b = process.memoryUsage().rss; const h = readFileSync(${JSON.stringify(big)}, 'utf8').slice(0, 65536);
      console.log(JSON.stringify({ n: h.length, grewMB: Math.round((process.memoryUsage().rss - b) / 1048576) }));`);
    check('control: the old whole-file read of the same transcript grows the process > 300 MB', old.grewMB > 300, JSON.stringify(old));
  } finally { cleanupSandbox(dir, { label: 'mem113' }); }
}

// MEM-119 — AFTER A QUERY, THE GARBAGE IS COLLECTED (debounced, off the request path). 10 scope:'all' searches on the
// author's corpus: heap 700 -> 1,333 MB without, ~700 MB with; footprint 1,784 vs 1,577 MB and still climbing without.
export async function afterQueryGcTests({ check, group }) {
  group('MEM-119 — garbage from a burst of queries is collected after it (debounced; never on the request path)');
  const probe = (env) => {
    const code = `const S = await import(${JSON.stringify(join(ROOT, 'lib', 'search.js'))});
      let junk = []; for (let i = 0; i < 40; i++) junk.push(new Array(500000).fill(0).map((_, k) => ({ k })));   // ~200+ MB of objects
      junk = null;
      const t0 = Date.now(); S.scheduleAfterQueryGc(); const returnedMs = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 2500));
      console.log(JSON.stringify({ returnedMs, state: S.afterQueryGcState() }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 120000, env: { ...process.env, MEMORY_LOG_LEVEL: 'warn', ...env } });
    try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { return { error: (r.stderr || '').slice(-300) }; }
  };
  const on = probe({});
  check('scheduling returns at once (the collection is never on the request path)', on.returnedMs !== undefined && on.returnedMs < 50, JSON.stringify(on));
  check('...and ~1.5 s later the grown heap is collected', on.state && on.state.ran === true && on.state.heapAfterMB < on.state.heapBeforeMB - 100, JSON.stringify(on));
  const off = probe({ MEMORY_AFTER_QUERY_GC: '0' });
  check('MEMORY_AFTER_QUERY_GC=0 turns it off (control: nothing runs)', off.state === null, JSON.stringify(off));
}
