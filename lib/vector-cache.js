// lib/vector-cache.js — vectors keyed by the TEXT they encode, not by the file
// they came from.
//
// WHY. Rebuilding the staging index took 43.8 minutes for 11,619 chunks, and it
// was ALL-OR-NOTHING: buildIndex writes once at the very end, so an interrupt at
// minute 40 loses everything. Worse, reuse was keyed off the previous INDEX by
// mtime+hash of the FILE — so editing one frontmatter line in 1,990 files (an
// account label; the bodies were untouched) invalidated every entry and forced a
// full re-embed of text that had not changed at all.
//
// A vector is a pure function of its text and the embedding contract. So cache
// it under sha256(text) and neither of those problems exists:
//   * a frontmatter edit re-embeds nothing, because the chunk text is identical
//   * an interrupted build keeps every vector it computed, because the cache is
//     flushed as it goes rather than at the end
//
// This is the shape a large sibling app already proves — 102k email vectors in
// their own sidecar store, independent of the database they describe.
//
// The contract is part of the key. If the model, pooling, dim or prefix changes,
// every previously written vector is meaningless; a stale cache would silently
// return garbage rather than erroring, so the header is checked and a mismatched
// cache is discarded rather than trusted.

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EMBEDDING } from './config.js';
import { log, warn } from './logger.js';
import { isVec, toVec, vecReplacer } from './vec.js';
import { stateRoot } from './state-root.js';

const contractKey = () => createHash('sha256')
  .update(JSON.stringify([EMBEDDING.model, EMBEDDING.pooling, EMBEDDING.dim, EMBEDDING.normalize, EMBEDDING.queryPrefix]))
  .digest('hex').slice(0, 16);

export const textKey = (t) => createHash('sha256').update(String(t)).digest('hex');

export function cachePath() {
  const v = process.env.MEMORY_VECTOR_CACHE;
  if (v === '0' || v === 'false') return null;
  // fileURLToPath, NOT `.pathname`. On Windows a file: URL's raw pathname is `/C:/Tools/...`, and
  // join() then produces `\\C:\\Tools\\...`, which Windows resolves against the CURRENT drive --
  // so the cache was written somewhere else, never found again, and EVERY index re-embedded the
  // whole corpus in silence. Measured on Windows: 18.9 s versus 1.1 s once it persists. Reported
  // from a real Windows install, 2026-09-05; every other module in this repo already did this
  // correctly, which is why it survived here alone.
  return v || join(stateRoot(), '.vector-cache.json')   /* see lib/state-root.js: a released copy, and a package install, must not fork the cache */;
}

export function loadCache() {
  const p = cachePath();
  const empty = { path: p, contract: contractKey(), vectors: new Map(), dirty: 0, hits: 0, misses: 0 };
  if (!p || !existsSync(p)) return empty;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.contract !== contractKey()) {
      warn(`vector cache was built under a different embedding contract — discarding it rather than returning vectors from another model`);
      return empty;
    }
    // Convert on load — a cache entry handed to cosine() must be the same type as everything else.
    empty.vectors = new Map(Object.entries(j.vectors || {}).map(([k, v]) => [k, toVec(v)]));
    log(`vector cache: ${empty.vectors.size} vectors loaded`);
    return empty;
  } catch (e) {
    warn(`vector cache unreadable (${e.message}); starting empty`);
    return empty;
  }
}

/** Atomic, so an interrupted flush cannot leave a torn cache. */
export function flushCache(c, { force = false } = {}) {
  if (!c?.path || (!c.dirty && !force)) return false;
  try {
    mkdirSync(dirname(c.path), { recursive: true });
    const tmp = `${c.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ contract: c.contract, vectors: Object.fromEntries(c.vectors) }, vecReplacer), 'utf8');
    renameSync(tmp, c.path);
    c.dirty = 0;
    return true;
  } catch (e) {
    try { unlinkSync(`${c.path}.${process.pid}.tmp`); } catch (_) { /* best effort */ }
    warn(`vector cache flush failed (${e.message}) — the build continues, it will just re-embed next time`);
    return false;
  }
}

export function cacheGet(c, text) {
  if (!c?.vectors) return null;
  const v = c.vectors.get(textKey(text));
  if (v) { c.hits++; return v; }
  c.misses++;
  return null;
}

export function cacheSet(c, text, vec) {
  if (!c?.vectors || !isVec(vec)) return;
  c.vectors.set(textKey(text), vec);
  c.dirty++;
}
