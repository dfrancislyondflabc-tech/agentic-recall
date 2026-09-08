#!/usr/bin/env node
// scripts/seed-vector-cache.js — fill the vector cache from indexes that already
// exist, so introducing the cache does not throw away work already paid for.
//
//   node scripts/seed-vector-cache.js
//
// The staging index cost 43.8 minutes of embedding. The cache is keyed by chunk
// TEXT and those vectors are already sitting in the index next to their text, so
// they can be lifted straight across — no model, no recompute.
//
// ONE HONEST GAP: the index stores each chunk's text AFTER the pattern guard has
// run, while buildIndex looks the cache up with the RAW text. For any chunk that
// was actually redacted the two differ, so that chunk misses and is re-embedded
// once. Every unredacted chunk — nearly all of them — matches exactly.

import { readFileSync, existsSync } from 'node:fs';
import { indexPath, stagingIndexPath } from '../lib/config.js';
import { loadCache, cacheSet, flushCache } from '../lib/vector-cache.js';
import { toVec } from '../lib/vec.js';

const cache = loadCache();
const before = cache.vectors.size;
let docs = 0, chunks = 0, summaries = 0;

for (const p of [indexPath(), stagingIndexPath()].filter(Boolean)) {
  if (!existsSync(p)) { console.log(`  skip (absent): ${p}`); continue; }
  let idx;
  try { idx = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.log(`  skip (unreadable): ${p}`); continue; }
  for (const d of idx.docs || []) {
    docs++;
    // Reconstructed exactly as buildIndex composes it, or the key will not match.
    if (toVec(d.summaryVec) && d.name) {
      cacheSet(cache, `${String(d.name).replace(/[-_]/g, ' ')}. ${d.description || ''}`, toVec(d.summaryVec));
      summaries++;
    }
    for (const c of d.chunks || []) {
      if (c && typeof c.text === 'string' && toVec(c.vec)) { cacheSet(cache, c.text, toVec(c.vec)); chunks++; }
    }
  }
  console.log(`  read ${idx.docs?.length || 0} docs from ${p.split('/').pop()}`);
}

flushCache(cache, { force: true });
console.log(`\n  seeded: ${chunks} chunk vectors + ${summaries} summary vectors across ${docs} docs`);
console.log(`  cache: ${before} -> ${cache.vectors.size} vectors`);
