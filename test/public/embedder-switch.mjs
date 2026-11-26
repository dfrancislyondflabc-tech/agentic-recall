// MEM-112 — THE EMBEDDER IS A SETTING; bge-small stays the default.
//
// Harrier-OSS-v1 0.6B can replace bge-small (MEMORY_EMBEDDER=harrier, or local-config "embedder"). It runs in the ONE
// shared embedding helper (~/Library/Application Support/EmbedHelper — one model for every session, exits when idle),
// never in-process. This proves, each in a fresh process: the default is bge-small with the shipped floors; harrier
// changes the header (so an old index is refused by name, never mixed), scales the absence scoreFloor by the measured
// ratio (0.38 -> 0.261) and ignores the bge-derived per-corpus table; and — when the helper is installed — embeds
// through it at 1024 wide with the query instruction applied once.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopChild } from './sandbox-cleanup.mjs';   // repo rule: tests that spawn import the cleanup helper (spawnSync ends its own child)

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
function probe(env, code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 180000, env: { ...process.env, MEMORY_EMBEDDER: '', ...env } });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { return { error: (r.stderr || r.stdout || '').slice(-300) }; }
}
const CFG = `const c = await import(${JSON.stringify(join(ROOT, 'lib', 'config.js'))}); const f = await import(${JSON.stringify(join(ROOT, 'lib', 'absence-floors.js'))});
  console.log(JSON.stringify({ embedder: c.EMBEDDER, model: c.EMBEDDING.model, dim: c.EMBEDDING.dim, pooling: c.EMBEDDING.pooling, floor: c.RETRIEVAL.absence.scoreFloor, books: f.floorsFor('books').scoreFloor }));`;

export async function embedderSwitchTests({ check, group }) {
  group('MEM-112 — the embedder is a setting (bge-small default; Harrier through the shared helper)');
  const d = probe({}, CFG);
  check('default embedder is bge-small, 384 wide, shipped floor 0.38, per-corpus table in force', d.embedder === 'bge-small' && d.dim === 384 && d.floor === 0.38 && d.books !== 0.38, JSON.stringify(d));
  const h = probe({ MEMORY_EMBEDDER: 'harrier' }, CFG);
  check('harrier: its own model, 1024 wide, last-token pooling (a bge index header no longer matches)', h.model === 'microsoft/harrier-oss-v1-0.6b' && h.dim === 1024 && h.pooling === 'last', JSON.stringify(h));
  check('harrier: absence scoreFloor scaled by the measured ratio (0.38 -> 0.261), bge-derived table not applied', h.floor === 0.261 && h.books === 0.261, JSON.stringify(h));
  const u = probe({ MEMORY_EMBEDDER: 'no-such-model' }, CFG);
  check('an unknown embedder name falls back to bge-small', u.embedder === 'bge-small', JSON.stringify(u));

  const installed = existsSync(join(homedir(), 'Library', 'Application Support', 'EmbedHelper', 'node_modules', 'node-llama-cpp'));
  if (!installed) { check('helper checks skipped: the shared embedding helper is not installed on this machine', true); return; }
  const e = probe({ MEMORY_EMBEDDER: 'harrier' }, `const E = await import(${JSON.stringify(join(ROOT, 'lib', 'embed.js'))});
    const p = await E.embedPassages(['The kiln must cool overnight or the glaze crazes.', 'Quarterly taxes are due in April.']);
    const q = await E.embedQuery('why did my glaze crack');
    console.log(JSON.stringify({ dims: [p[0].length, q.length], kiln: E.cosine(q, p[0]), taxes: E.cosine(q, p[1]), norm: Math.hypot(...p[0]) }));`);
  check('harrier embeds through the shared helper: 1024 wide, unit length', e.dims && e.dims[0] === 1024 && e.dims[1] === 1024 && Math.abs(e.norm - 1) < 1e-3, JSON.stringify(e));
  check('...and ranks by meaning: a cracked-glaze question is nearer the kiln note than the taxes note', e.kiln > e.taxes + 0.1, JSON.stringify(e));
}
