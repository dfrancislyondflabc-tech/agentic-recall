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
import { EMBEDDING, embedderFile } from './config.js';
import { log, warn } from './logger.js';
import { isVec, toVec } from './vec.js';
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
  return v || join(stateRoot(), embedderFile('.vector-cache.json'))   /* MEM-121: each embedder its own cache */   /* see lib/state-root.js: a released copy, and a package install, must not fork the cache */;
}

// ── THE BINARY CACHE (MEM-116) ──────────────────────────────────────────────────────────────────────────────
//
// 🟥 The cache was one JSON object of base64 vectors: 190 MB on Daniel's Mac (90k vectors), parsed on EVERY index build
// (+0.5–0.8 GB measured) and rewritten whole at the end of every build — even one that embedded nothing. The capture
// timer builds the staging index every few minutes while he works, so that was a recurring 2.3 GB process.
// Now: `<cache>.bin` = 'ARVC' + uint32 version + uint32 header length + header JSON {contract, dim, count} (space-padded
// to 4) + count × 32-byte sha256 keys + count × dim float32. Every vector is a view of one buffer; flushed only when
// something was added. The legacy `.json` is READ once (migration) and never written again by this code — a server from
// before this release keeps using its own copy, and since every entry is keyed by (contract, sha256 of the text) two
// copies can only differ in what they hold, never in what a key means.
const MAGIC = 'ARVC';
const BIN_VERSION = 1;
export function binPath(p = cachePath()) { return p ? (p.endsWith('.json') ? p.slice(0, -5) : p) + '.bin' : null; }

function loadBin(bp, empty) {
  const b = readFileSync(bp);
  if (b.length < 12 || b.toString('latin1', 0, 4) !== MAGIC) throw new Error('not a vector cache file');
  if (b.readUInt32LE(4) !== BIN_VERSION) throw new Error(`vector cache version ${b.readUInt32LE(4)}, this build reads ${BIN_VERSION}`);
  const hlen = b.readUInt32LE(8);
  const h = JSON.parse(b.toString('utf8', 12, 12 + hlen));
  if (h.contract !== empty.contract || h.dim !== EMBEDDING.dim) return 'contract';
  const kOff = 12 + hlen, vOff = kOff + h.count * 32, end = vOff + h.count * h.dim * 4;
  if (b.length !== end) throw new Error(`vector cache is ${b.length} bytes, its header says ${end}`);
  const all = (b.byteOffset + vOff) % 4 === 0 ? new Float32Array(b.buffer, b.byteOffset + vOff, h.count * h.dim)
    : new Float32Array(b.buffer.slice(b.byteOffset + vOff, b.byteOffset + end));
  for (let i = 0; i < h.count; i++) {
    empty.vectors.set(b.toString('hex', kOff + i * 32, kOff + (i + 1) * 32), all.subarray(i * h.dim, (i + 1) * h.dim));
  }
  return 'ok';
}

export function loadCache() {
  const p = cachePath();
  const empty = { path: p, contract: contractKey(), vectors: new Map(), dirty: 0, hits: 0, misses: 0 };
  if (!p) return empty;
  const bp = binPath(p);
  if (existsSync(bp)) {
    try {
      const r = loadBin(bp, empty);
      if (r === 'contract') {
        warn(`vector cache was built under a different embedding contract — discarding it rather than returning vectors from another model`);
        return { ...empty, vectors: new Map() };
      }
      log(`vector cache: ${empty.vectors.size} vectors loaded`);
      return empty;
    } catch (e) {
      warn(`vector cache unreadable (${e.message}); starting empty`);
      return { ...empty, vectors: new Map() };
    }
  }
  if (!existsSync(p)) return empty;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.contract !== contractKey()) {
      warn(`vector cache was built under a different embedding contract — discarding it rather than returning vectors from another model`);
      return empty;
    }
    // Convert on load — a cache entry handed to cosine() must be the same type as everything else.
    empty.vectors = new Map(Object.entries(j.vectors || {}).map(([k, v]) => [k, toVec(v)]));
    empty.dirty = empty.vectors.size ? 1 : 0;              // MEM-116: migrate — the first flush writes the .bin
    log(`vector cache: ${empty.vectors.size} vectors loaded (legacy JSON; written as ${bp.split(/[\\/]/).pop()} from now on)`);
    return empty;
  } catch (e) {
    warn(`vector cache unreadable (${e.message}); starting empty`);
    return empty;
  }
}

/** Atomic, so an interrupted flush cannot leave a torn cache. Writes the binary cache (MEM-116), and only when
 *  something was added — `force` writes it regardless (scripts/seed-vector-cache.js). */
export function flushCache(c, { force = false } = {}) {
  if (!c?.path || (!c.dirty && !force)) return false;
  const bp = binPath(c.path);
  const tmp = `${bp}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(bp), { recursive: true });
    const dim = EMBEDDING.dim;
    const entries = [...c.vectors].filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && isVec(v) && v.length === dim);
    let head = Buffer.from(JSON.stringify({ contract: c.contract, dim, count: entries.length }), 'utf8');
    if (head.length % 4) head = Buffer.concat([head, Buffer.alloc(4 - (head.length % 4), 0x20)]);
    const out = Buffer.allocUnsafe(12 + head.length + entries.length * (32 + dim * 4));
    out.write(MAGIC, 0, 'latin1'); out.writeUInt32LE(BIN_VERSION, 4); out.writeUInt32LE(head.length, 8);
    head.copy(out, 12);
    const kOff = 12 + head.length, vOff = kOff + entries.length * 32;
    entries.forEach(([k, v], i) => {
      out.write(k, kOff + i * 32, 32, 'hex');
      Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(out, vOff + i * dim * 4);
    });
    writeFileSync(tmp, out);
    renameSync(tmp, bp);
    c.dirty = 0;
    return true;
  } catch (e) {
    try { unlinkSync(tmp); } catch (_) { /* best effort */ }
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
