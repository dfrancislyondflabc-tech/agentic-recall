// lib/embed.js — dense side. Lazy, optional, and LOUD when it fails.
//
// If @xenova/transformers cannot load (not installed, model not cached, no
// network on first run), we do not throw: retrieval degrades to BM25-only and
// says so, in the logs and in every search response's `mode` field. Silent
// degradation is the failure mode that wastes a week.
//
// bge-small-en-v1.5 is ASYMMETRIC. The prefix goes on QUERIES ONLY.

import { EMBEDDING, modelCacheDir } from './config.js';
import { log, warn, error } from './logger.js';

let pipePromise = null;
let disabledReason = null;

export function embeddingsDisabledReason() {
  return disabledReason;
}

async function getPipe() {
  if (disabledReason) return null;
  if (!pipePromise) {
    pipePromise = (async () => {
      const t0 = Date.now();
      const { env, pipeline } = await import('@xenova/transformers');
      env.cacheDir = modelCacheDir();
      env.allowLocalModels = true;
      const pipe = await pipeline('feature-extraction', EMBEDDING.model, { quantized: true });
      log(`embedding model ready: ${EMBEDDING.model} (${Date.now() - t0} ms)`);
      return pipe;
    })().catch((e) => {
      disabledReason = `embedding model unavailable: ${e.message}`;
      error(`DENSE RETRIEVAL DISABLED — ${disabledReason}. Falling back to BM25-only. ` +
            `Fix: run \`npm run index\` with network access so the model caches into ${modelCacheDir()}.`);
      return null;
    });
  }
  return pipePromise;
}

export async function embeddingsAvailable() {
  return (await getPipe()) !== null;
}

/** Embed PASSAGES — bare, no prefix. */
export async function embedPassages(texts, onProgress) {
  return embedBatched(texts, false, onProgress);
}

/** Embed QUERIES — with the bge query prefix. Getting this backwards is silent. */
export async function embedQuery(text) {
  const vecs = await embedBatched([EMBEDDING.queryPrefix + text], true);
  return vecs ? vecs[0] : null;
}

// ── MEMORY-BOUNDED FORWARD PASSES (MEM-111, 2026-11-24) ─────────────────────
// The ONNX runtime keeps the memory of the LARGEST forward pass it has run, and a pass costs (texts) × (longest text):
// every text is padded to the longest and attention is quadratic in it. 16 texts in ARRIVAL order put one long chunk
// (code, JSON, logs reach the model's 512-token limit) beside 15 short ones and padded them all — a capture process
// was seen at 1.9 GB 22 s after starting, on a 16 GB Mac that ended up 27 GB into swap (2026-11-24). Measured on the same
// engine in the Email Backup app (EB-473, 5,120 real passages): 8 long/pass 2.1 GB · 4: 1.17 GB · 2: 0.76 GB, and 2 was
// also the FASTEST (less padding). So: sort by length, at most PASS_CHAR_BUDGET characters per pass counted as
// (texts) × (longest, capped at what the model reads), and restore the caller's order.
export const PASS_CHAR_BUDGET = 2 * 2600;
export const MODEL_READS_CHARS = 2600;     // 512 tokens ≈ 2,000–2,600 chars; longer text costs no more than this
const MAX_PER_PASS = 64;

/** Split items (already sorted by length, shortest first) into memory-bounded passes. Pure. */
export function memoryBoundedPasses(items, budget = PASS_CHAR_BUDGET, maxCount = MAX_PER_PASS) {
  const out = []; let cur = [];
  for (const it of items) {
    const len = Math.min(String(it.text || '').length, MODEL_READS_CHARS) || 1;
    if (cur.length && (cur.length + 1 > maxCount || (cur.length + 1) * len > budget)) { out.push(cur); cur = []; }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

// macOS publishes its own memory verdict: kern.memorystatus_vm_pressure_level 1 = normal, 2 = warning, 4 = critical.
// Passage embedding (indexing — background work that can wait) waits while it is not normal; queries never wait.
// Fail-open: off macOS or if sysctl fails, "normal".
let _pressureProbe = null;
export function _setPressureProbeForTest(fn) { _pressureProbe = fn; }
async function pressureLevel() {
  if (_pressureProbe) return _pressureProbe();
  if (process.platform !== 'darwin') return 1;
  const { execFile } = await import('node:child_process');
  return new Promise((res) => execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 },
    (err, out) => { const n = Number(String(out || '').trim()); res(err || !Number.isFinite(n) ? 1 : n); }));
}
const PRESSURE_WAIT_MS = 10 * 60 * 1000;   // give up waiting after 10 min (then go on, one small pass at a time)
async function waitForMemory() {
  const t0 = Date.now(); let warned = false;
  for (;;) {
    const lvl = await pressureLevel();
    if (lvl <= 1) return;
    if (!warned) { warn(`indexing paused: macOS memory pressure is ${lvl >= 4 ? 'CRITICAL' : 'WARNING'} — resumes when normal`); warned = true; }
    if (Date.now() - t0 > PRESSURE_WAIT_MS) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function embedBatched(texts, isQuery, onProgress) {
  const pipe = await getPipe();
  if (!pipe) return null;
  const out = new Array(texts.length);
  const items = texts.map((text, ix) => ({ ix, text }));
  items.sort((a, b) => a.text.length - b.text.length);
  let done = 0;
  for (const pass of memoryBoundedPasses(items)) {
    if (!isQuery) await waitForMemory();
    const res = await pipe(pass.map((x) => x.text), { pooling: EMBEDDING.pooling, normalize: EMBEDDING.normalize });
    const dim = res.dims[res.dims.length - 1];
    if (dim !== EMBEDDING.dim) {
      disabledReason = `model returned dim ${dim}, contract expects ${EMBEDDING.dim}`;
      error(`DENSE RETRIEVAL DISABLED — ${disabledReason}`);
      return null;
    }
    for (let r = 0; r < pass.length; r++) {
      // Float32Array copy: storing into it IS the float32 rounding Math.fround used to do,
      // minus an intermediate array and 384 closure calls per chunk.
      out[pass[r].ix] = new Float32Array(res.data.subarray(r * dim, (r + 1) * dim));
    }
    done += pass.length;
    if (onProgress) onProgress(done, texts.length);
  }
  if (isQuery === false && !out.length) warn('embedPassages produced no vectors');
  return out;
}

/** Vectors are L2-normalised, so cosine is a plain dot product. */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * The exact inverse of chunkBody(): stitch the stored chunks back into the
 * whitespace-normalised body, dropping each chunk's overlap with its
 * predecessor.
 *
 * The index stores chunks, not bodies. The keyword leg needs the body (a term
 * counted once per occurrence, not 1.25× because 40 of every 160 words appear
 * in two chunks), and the phrase leg needs one continuous token sequence — a
 * quote that straddles a chunk boundary must still be findable. Reconstructing
 * costs one array walk and keeps the index format unchanged.
 *
 * Correctness rests on the chunker's own arithmetic: chunk k covers words
 * [step*k, step*k + chunkWords), so every chunk after the first repeats exactly
 * `chunkOverlapWords` words. The loop's break condition guarantees the final
 * chunk is longer than the overlap, so nothing is ever dropped.
 */
export function unchunkBody(chunkTexts) {
  const { chunkOverlapWords } = EMBEDDING;
  if (!chunkTexts?.length) return '';
  const words = chunkTexts[0].split(' ');
  for (let i = 1; i < chunkTexts.length; i++) {
    const w = chunkTexts[i].split(' ');
    if (w.length <= chunkOverlapWords) continue;    // fully contained in its predecessor
    for (let j = chunkOverlapWords; j < w.length; j++) words.push(w[j]);
  }
  return words.join(' ');
}

// ---- THE PER-DOCUMENT CHUNK CAP -------------------------------------------
//
// MEM-52 / campaign C, C-2. `chunkBody` had no cap, and a single 6 MB exchange in a FIVE-file
// store measured 5,618 of 5,628 chunks and a 339.1 s rebuild — longer than the 300 s tick the
// whole capture promise is written against, with everything else in the corpus serialised behind
// the same lock. One pasted log, one imported document, one very long assistant answer does it.
//
// 200 IS MEASURED, not a round number. Per-document chunk counts over the author's real corpora,
// read-only, 2026-09-05:
//
//   staging store, 2,921 documents:  p50 4, p90 13, p95 20, p99 46, p99.9 65, MAX 121
//   curated index,   420 documents:  p50 3, p90  9, p95 14, p99 24, p99.9 55, MAX  88
//
// So the cap is 4.3x the largest document either corpus has ever held and ~4x p99.9: nothing that
// exists today is touched, and the ~0.06 s/chunk embedding cost is bounded at roughly 12 s for a
// document of any size. MEMORY_MAX_CHUNKS_PER_DOC raises or lowers it; a very large number
// restores the old unbounded behaviour for a deliberate one-off bulk import.
//
// WHAT IS KEPT: the first N chunks — the head of the document — plus its summary vector, which is
// built from name + description and is therefore unaffected. The document stays findable, which is
// the rule that mattered: it is indexed, it is retrievable, `get` still returns the whole body from
// disk, and the doc carries `chunksTruncated: {kept, total}` so a reader can be told the tail was
// not embedded.
export const DEFAULT_MAX_CHUNKS_PER_DOC = 200;

export function maxChunksPerDoc() {
  const v = Number(process.env.MEMORY_MAX_CHUNKS_PER_DOC ?? DEFAULT_MAX_CHUNKS_PER_DOC);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_MAX_CHUNKS_PER_DOC;
}

/**
 * ~200-word windows with ~40-word overlap, headings kept with their text — capped.
 *
 * Returns { chunks, total, truncated }: `total` is what the body WOULD have produced, so the
 * warning and the doc stamp can name the real size rather than the capped one. Counting past the
 * cap costs one integer per window and no string work.
 */
export function chunkBodyDetailed(body, { max = maxChunksPerDoc() } = {}) {
  const { chunkWords, chunkOverlapWords } = EMBEDDING;
  const words = String(body ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return { chunks: [], total: 0, truncated: false };
  const step = Math.max(1, chunkWords - chunkOverlapWords);
  const chunks = [];
  let total = 0;
  for (let i = 0; i < words.length; i += step) {
    if (i >= words.length) break;
    total++;
    if (chunks.length < max) chunks.push(words.slice(i, i + chunkWords).join(' '));
    if (i + chunkWords >= words.length) break;
  }
  return { chunks, total, truncated: total > chunks.length };
}

/** The chunk TEXTS, capped. Unchanged signature and unchanged output for every document under the cap. */
export function chunkBody(body, opts) {
  return chunkBodyDetailed(body, opts).chunks;
}
