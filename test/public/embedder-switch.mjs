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
  // MEM-121: own files per embedder, its own measured fusion weights, the vector sidecar on by default for it
  const FILES = `const c = await import(${JSON.stringify(join(ROOT, 'lib', 'config.js'))}); const v = await import(${JSON.stringify(join(ROOT, 'lib', 'vector-cache.js'))});
    const b = (p) => p && p.split(/[\\\\/]/).pop();
    console.log(JSON.stringify({ staging: b(c.stagingIndexPath()), curated: b(c.indexPath()), handoff: b(c.handoffIndexPath()), projects: b(c.projectsIndexPath()), lib: b(c.libraryIndexPath('books')),
      cache: b(v.cachePath()), bin: b(v.binPath()), fuse: c.RETRIEVAL.fuse, sidecar: c.vecSidecarEnabled() }));`;
  const clean = { MEMORY_INDEX: '', MEMORY_STAGING_INDEX: '', MEMORY_HANDOFF_INDEX: '', MEMORY_PROJECTS_INDEX: '', MEMORY_VECTOR_CACHE: '', MEMORY_LIBRARY_INDEX_DIR: '', MEMORY_VEC_SIDECAR: '' };
  const fb = probe(clean, FILES), fh = probe({ ...clean, MEMORY_EMBEDDER: 'harrier' }, FILES);
  check('bge-small keeps its file names exactly (.staging-index.json, .vector-cache.json/.bin) — nothing moves for a default install',
    fb.staging === '.staging-index.json' && fb.curated === '.memory-index.json' && fb.cache === '.vector-cache.json' && fb.bin === '.vector-cache.bin' && fb.lib === '.lib-books-index.json', JSON.stringify(fb));
  check('harrier has its OWN index and cache files, so a changeover never rewrites what a bge (or older) server is reading',
    fh.staging === '.staging-index.harrier.json' && fh.curated === '.memory-index.harrier.json' && fh.handoff === '.handoff-index.harrier.json' && fh.projects === '.projects-index.harrier.json'
    && fh.lib === '.lib-books-index.harrier.json' && fh.cache === '.vector-cache.harrier.json' && fh.bin === '.vector-cache.harrier.bin', JSON.stringify(fh));
  check('fusion weights follow the embedder: bge 0.42/0.42 (its measured best), harrier keyword 0.30 / meaning 0.54 (79 vs 74 of 90)',
    fb.fuse && fb.fuse.keyword === 0.42 && fb.fuse.semantic === 0.42 && fh.fuse && fh.fuse.keyword === 0.3 && fh.fuse.semantic === 0.54, JSON.stringify({ b: fb.fuse, h: fh.fuse }));
  check('the vector sidecar (format 3) is on by default for harrier\'s own files, off for bge\'s shared ones; the setting still wins',
    fh.sidecar === true && fb.sidecar === false && probe({ ...clean, MEMORY_EMBEDDER: 'harrier', MEMORY_VEC_SIDECAR: '0' }, FILES).sidecar === false, JSON.stringify({ fb: fb.sidecar, fh: fh.sidecar }));
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
