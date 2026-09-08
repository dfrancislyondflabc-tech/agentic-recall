// lib/vec.js — one representation for embedding vectors, and one place that says so.
//
// ── THE INVARIANT ──────────────────────────────────────────────────────────
//
//   Vectors are Float32Array EVERYWHERE in memory.
//   A plain array (index format v1) or a base64 string (v2) exists only inside a JSON string.
//
// It holds if and only if every JSON.parse that can yield a vector converts, and every
// JSON.stringify that can emit one un-converts. There are exactly three parse sites and two
// stringify sites in this repo:
//
//   parse      lib/index-store.js  readIndexRaw()   -- feeds BOTH loadIndex and the build-reuse path
//   parse      lib/vector-cache.js loadCache()      -- feeds the cache-mixing path in buildIndex
//   parse      scripts/seed-vector-cache.js         -- parses index files itself
//   stringify  lib/index-store.js  (the index file)
//   stringify  lib/vector-cache.js (the cache file)
//
// Converting inside readIndexRaw rather than inside loadIndex is deliberate: buildIndex carries
// `before.chunks` straight over from a parsed index and mixes fresh embeddings with cache entries,
// so converting at the parse makes a mixed-type index structurally impossible instead of merely
// reviewed.
//
// ── WHY THIS FILE EXISTS RATHER THAN A FEW INLINE CHECKS ───────────────────
//
// Every way of getting this wrong is SILENT. `Array.isArray(new Float32Array(384))` is false, so a
// missed call site does not throw — it quietly decides there are no vectors. The observed failures
// would be: dense retrieval switching itself off for the whole corpus, the vector cache dropping
// every write so each build re-embeds from scratch, and semantic neighbours returning empty. None
// of them logs anything. `isVec` is therefore the ONLY type predicate used for a vector anywhere
// in the codebase, so the invariant can be checked by grep rather than by reasoning.
//
// Float32 loses nothing: transformers.js already emits float32 values, and the plain arrays merely
// stored them in float64 slots. Measured on the real corpus — largest similarity change 0.00e+0,
// zero rank changes. See test/vector-representation-preregistration.md.

import { EMBEDDING } from './config.js';

/** The one type predicate. Nothing else may ask "is this a vector?". */
export const isVec = (x) => x instanceof Float32Array;

/**
 * Anything that can legitimately hold a vector -> Float32Array. Returns null for anything else,
 * so a caller that gets null knows the shape was unrecognised rather than receiving a short or
 * empty vector it would silently score against.
 */
export function toVec(x) {
  if (x == null) return null;
  if (isVec(x)) return x;
  if (Array.isArray(x)) {
    // 🟥 THE SAME LENGTH CHECK THE BASE64 BRANCH HAS. It was missing here, and the asymmetry was
    // not harmless: a wrong-length ARRAY vector was accepted, cosine() then summed over a shorter
    // run and returned NaN, and NaN loses every comparison — so the affected documents did not
    // score badly, they DISAPPEARED from the results, while the response still said
    // confidence:"high". A short vector must be refused exactly as loudly as a truncated blob.
    if (x.length !== EMBEDDING.dim) {
      throw new Error(`vector array has ${x.length} values, contract expects ${EMBEDDING.dim}`);
    }
    return Float32Array.from(x);
  }
  if (typeof x === 'string') return fromBase64(x);
  return null;
}

/**
 * base64 -> Float32Array.
 *
 * Two things here are not incidental:
 *  - THE COPY. Buffer.from(str,'base64') is carved out of Node's shared 8 KB pool. A zero-copy
 *    view over it would pin that whole slab for the lifetime of one 1.5 KB vector, which on a
 *    15,000-vector index is the opposite of the change's purpose.
 *  - THE LOUD FAILURE. A truncated or corrupted blob must not become a short vector: cosine()
 *    would happily score it against a full-length query and return a plausible wrong number. It
 *    throws instead, and the caller reports which document.
 */
function fromBase64(s) {
  const buf = Buffer.from(s, 'base64');
  if (buf.byteLength % 4 !== 0) throw new Error(`vector blob is ${buf.byteLength} bytes, not a whole number of float32s`);
  const out = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (out.length !== EMBEDDING.dim) throw new Error(`vector blob decodes to ${out.length} floats, contract expects ${EMBEDDING.dim}`);
  return out;
}

/**
 * The on-disk encoding. Flipping this default plus INDEX_FORMAT_VERSION is the whole of the
 * v1 -> v2 change; `toVec` reads both regardless, which is what makes the migration cost nothing.
 *
 * 🟥 THE ORDERING OF THIS DEFAULT AGAINST INDEX_FORMAT_VERSION IS LOAD-BEARING. A first version
 * of this file defaulted to 'base64' while INDEX_FORMAT_VERSION was still 1. Within four minutes
 * a routine staleness rebuild rewrote the real curated index in base64 — a format the RELEASED
 * reader does not understand. It did not crash: `Array.isArray` simply saw no vectors, and the
 * index loaded `dense=false`, serving BM25-only answers with no error anywhere. That is exactly
 * the silent failure this campaign's pre-registration predicted, and it happened to a live index.
 *
 * The lesson is the ordering: the on-disk format must not move until INDEX_FORMAT_VERSION is
 * bumped and `validateHeader` can refuse a too-new index LOUDLY. Both are now in place
 * (version 2, ACCEPTED_FORMAT_VERSIONS in lib/index-store.js), so base64 is the default. Set
 * MEMORY_VEC_ENCODING=array to write the old shape — useful for handing an index to an older
 * build, and used by the suite to prove BOTH encodings still load.
 */
export const VEC_ENCODING = process.env.MEMORY_VEC_ENCODING === 'array' ? 'array' : 'base64';

/** Float32Array -> the JSON-safe shape. NEVER let a Float32Array reach JSON.stringify directly:
 *  it serialises to {"0":0.12,"1":-0.03,…}, silently, as valid JSON that no longer round-trips. */
export function fromVec(v) {
  if (!isVec(v)) return v;
  if (VEC_ENCODING === 'array') return Array.from(v);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

/** Pass to JSON.stringify as the replacer so no vector can escape un-encoded by accident. */
export const vecReplacer = (_key, value) => (isVec(value) ? fromVec(value) : value);

/** Walk a parsed index in place, converting every vector it holds. The single conversion point. */
export function hydrateIndex(raw) {
  for (const d of raw?.docs || []) {
    if (d.summaryVec != null) d.summaryVec = toVec(d.summaryVec);
    for (const c of d.chunks || []) if (c.vec != null) c.vec = toVec(c.vec);
  }
  return raw;
}
