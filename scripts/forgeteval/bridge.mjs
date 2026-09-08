#!/usr/bin/env node
// scripts/forgeteval/bridge.mjs — the memory server half of the ForgetEval
// adapter (Phase 1c). A persistent process (the embedding model is the whole
// cost) speaking JSONL on stdin/stdout:
//
//   {"op":"reset"} | {"op":"inscribe","text"} | {"op":"recall","query","k"}
//   {"op":"supersede","old_query","new_text"} | {"op":"release","query"}
//
// SANDBOXED BY CONSTRUCTION, per the documented MEMORY_INDEX-only-redirects
// trap: EVERY corpus root and EVERY index path is redirected into a temp dir
// before any lib module loads — the live memory folder and the live indexes
// are unreachable from this process. No network: the embedder loads from the
// repo's own .model-cache; nothing else reaches out.
//
// HONEST PRIMITIVE MAPPING (recorded in test/BASELINE-2026-08.md):
//   inscribe  -> write a curated .md memory; the next search's freshness
//                guard rebuilds the sandbox index inline (the real path).
//   recall    -> memory search, scope curated; texts = results' bodies,
//                then bestWeak bodies (both are texts a caller receives).
//   supersede -> rewrite the top-1 file's body (how supersession actually
//                happens here: a session edits the memory file).
//   release   -> demote to archive (setTier) — our ONLY soft-evict. Archive
//                stays searchable, so decay/amnesia tests score our real
//                behavior, not a flattering emulation.
//   purge     -> NOT BRIDGED. The server deliberately has no delete path;
//                the Python side raises NotImplementedError (scored N/A).

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const SANDBOX = mkdtempSync(join(tmpdir(), 'forgeteval-'));
const MEM = join(SANDBOX, 'mem');
mkdirSync(MEM, { recursive: true });

// The FULL redirect, before any lib import runs.
process.env.MEMORY_DIR = MEM;
process.env.MEMORY_INDEX = join(SANDBOX, 'idx.json');
process.env.MEMORY_STAGING_INDEX = '0';
process.env.MEMORY_HANDOFF_INDEX = '0';
process.env.MEMORY_PROJECTS_INDEX = '0';
process.env.MEMORY_HANDOFF_DOCS = '0';
process.env.MEMORY_ALL_PROJECTS = '0';
process.env.MEMORY_LIBRARY = '0';
process.env.MEMORY_OWN_STORE = '0';
process.env.MEMORY_QUERY_LOG = '0';
process.env.MEMORY_QUERY_SOURCE = 'test';
process.env.MEMORY_GIT_REPOS = '';
process.env.MEMORY_AUTO_VERIFY = '0';
process.env.MEMORY_VECTOR_CACHE = join(SANDBOX, 'vec-cache.json');

const { search, invalidate, getIndex } = await import('../../lib/search.js');
const { forgetStatCache } = await import('../../lib/freshness.js');
const { setTier } = await import('../../lib/corpus.js');
const { bodyOf } = await import('../../lib/bm25.js');

let n = 0;
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'fact';

function writeFact(file, text) {
  const name = file.replace(/\.md$/, '');
  const desc = String(text).replace(/\s+/g, ' ').slice(0, 120);
  writeFileSync(join(MEM, file), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${text}\n`, 'utf8');
}

async function freshSearch(query, k) {
  forgetStatCache();
  invalidate();
  return search(query, { scope: 'curated', limit: k });
}

const textsOf = async (res) => {
  const idx = getIndex({ scope: 'curated' });
  const byName = new Map(idx.docs.map((d) => [d.name, d]));
  const rows = [...(res.results || []), ...(res.bestWeak || [])];
  return rows.map((r) => {
    const d = byName.get(r.name);
    return d ? String(bodyOf(d) || '') : `${r.description || ''} ${r.snippet || ''}`;
  });
};

const ops = {
  async reset() {
    rmSync(MEM, { recursive: true, force: true });
    rmSync(join(SANDBOX, 'idx.json'), { force: true });
    mkdirSync(MEM, { recursive: true });
    n = 0;
    invalidate(); forgetStatCache();
    return { ok: true };
  },
  async inscribe({ text }) {
    n++;
    writeFact(`f${String(n).padStart(4, '0')}-${slug(text)}.md`, text);
    return { ok: true, id: n };
  },
  async recall({ query, k = 5 }) {
    const res = await freshSearch(query, k);
    return { ok: true, texts: (await textsOf(res)).slice(0, k) };
  },
  async supersede({ old_query, new_text }) {
    const res = await freshSearch(old_query, 1);
    const top = (res.results || [])[0] || (res.bestWeak || [])[0];
    if (!top) { return ops.inscribe({ text: new_text }); }
    const idx = getIndex({ scope: 'curated' });
    const doc = idx.docs.find((d) => d.name === top.name);
    if (!doc) { return ops.inscribe({ text: new_text }); }
    writeFact(doc.file, new_text);
    return { ok: true };
  },
  async release({ query }) {
    const res = await freshSearch(query, 20);
    const idx = getIndex({ scope: 'curated' });
    const rows = [...(res.results || []), ...(res.bestWeak || [])];
    let count = 0;
    for (const r of rows) {
      const doc = idx.docs.find((d) => d.name === r.name);
      if (doc && doc.tier !== 'archive') { setTier(doc.path, 'archive'); count++; }
    }
    return { ok: true, count };
  }
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); continue; }
  try {
    const out = await (ops[msg.op] ? ops[msg.op](msg) : Promise.reject(new Error('unknown op ' + msg.op)));
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + '\n');
  }
}
