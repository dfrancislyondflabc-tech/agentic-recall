// ci-helpers/warm-model.mjs — download/warm the embedding model, and REFUSE a silent BM25 run.
//
// lib/embed.js degrades to keyword-only when the model cannot load, deliberately and quietly
// (a server that stops answering is worse than one that answers less well). In CI that same
// property means a job can go green over a dead embedder: the stress harness would still capture,
// still index, still return rows — and would have proved nothing about the half of retrieval that
// needs a vector. So the depth jobs warm the model FIRST and fail here, once, with a readable
// reason, instead of somewhere downstream with a confusing one.
//
// It also checks the file landed in the cache, because `actions/cache` only helps if what the
// embedder wrote is what the cache path points at.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { embedQuery, embeddingsDisabledReason } from '../lib/embed.js';
import { EMBEDDING, modelCacheDir } from '../lib/config.js';

const v = await embedQuery('a wheel was trued in the workshop before the hub was reassembled');
if (!v || v.length !== EMBEDDING.dim) {
  console.error(`FAIL: no dense vector (${v ? v.length : 'null'}) — ${embeddingsDisabledReason() || 'unknown reason'}`);
  process.exit(1);
}
const onnx = join(modelCacheDir(), EMBEDDING.model, 'onnx', 'model_quantized.onnx');
if (!existsSync(onnx)) {
  console.error(`FAIL: embeddings worked but the model is not at ${onnx} — the cache path is wrong`);
  process.exit(1);
}
console.log(`OK dense embeddings live: ${EMBEDDING.model}, dim ${v.length}, cached at ${modelCacheDir()}`);
