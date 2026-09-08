#!/usr/bin/env node
// scripts/derive-absence-floors.js — absence floors, per corpus, DERIVED.
//
//   node scripts/derive-absence-floors.js [--out lib/absence-floors.json]
//
// THE LAW: constants do not travel between corpora. This repo has paid for it
// twice — blending staging into curated cost MRR 0.826 → 0.681, and
// `referenceChunks` is derived per corpus for exactly this reason. The absence
// floors were the remaining violation: four numbers calibrated on curated,
// applied unchanged to a library category that is often ONE BOOK, where nearly
// every distinctive word appears in nearly every chapter, IDF collapses toward
// zero, and the fused score has a far lower ceiling (Phase 4b measured the
// keyword leg at k = 0 there).
//
// THE DERIVATION. For each corpus, ask it questions it can certainly answer —
// each document's own heading, or its description — and record where its own
// answers land. The corpus's floors are curated's carried across at the SAME
// RELATIVE POSITION:
//
//   scoreFloor_c    = scoreFloor_curated    × (medianTopScore_c / medianTopScore_curated)
//   coverageFloor_c = coverageFloor_curated × (medianCoverage_c / medianCoverage_curated)
//
// Each floor is scaled by the median of THE STATISTIC IT MEASURES — a score
// floor by scores, a coverage floor by coverage. Scaling one by the other
// would be numerology.
//
// NOT RESCALED: `phraseFloor` and `orphanFloor`. Both are already
// corpus-relative by construction, and `orphanShare` in particular is the
// fabricated-term detector — the thing that catches "the Thrymvold Concordat"
// — and it must keep its full strength in every corpus.
//
// Curated re-derives to its own shipped constants by construction (its ratio
// is 1.0). That is asserted, not assumed: a derivation that moves the corpus
// it was calibrated on is wrong.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, getIndex } from '../lib/search.js';
import { RETRIEVAL, libraryCorpora } from '../lib/config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

// How many self-queries per corpus. Enough for a stable median, few enough to
// run in a minute — this is a calibration, not a benchmark.
const SAMPLE = Number(process.env.MEMORY_FLOOR_SAMPLE || 40);

const median = (xs) => {
  const a = xs.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const r4 = (n) => Number(Number(n).toFixed(4));

/**
 * Questions a corpus can certainly answer: its own headings, else its own
 * descriptions. Sampled evenly across the corpus so one fat document cannot
 * dominate, and deterministic so a re-run reproduces.
 */
// 🟥 NOT THE HEADING. The first draft queried each document by its own
// heading, which is a near-verbatim lookup: curated's median top score came
// back at 1.0444 and books' at 0.9582, a ratio of 0.92 that says the two
// corpora are almost identical. They are not — it says heading lookups are
// easy everywhere. It also skipped `manuals` entirely, because its headings
// are "p.5" and carry no vocabulary at all.
//
// Content words drawn from ACROSS the body approximate what a person actually
// asks: several terms about the subject, none of them the title, not adjacent.
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'were', 'has', 'have',
  'not', 'but', 'they', 'their', 'his', 'her', 'its', 'are', 'you', 'all', 'any', 'can', 'had', 'him',
  'she', 'who', 'which', 'what', 'when', 'there', 'been', 'would', 'could', 'into', 'than', 'then', 'them']);

function selfQueries(docs, n) {
  const cands = [];
  for (const d of docs) {
    const body = (d.chunks || []).map((c) => c.text).join(' ') || d.body || '';
    const words = String(body).replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()));
    if (words.length < 24) continue;
    // Six terms spread across the whole document, deterministically.
    const step = Math.floor(words.length / 6);
    const picked = [];
    for (let i = 0; i < 6; i++) picked.push(words[i * step]);
    cands.push([...new Set(picked)].join(' '));
  }
  if (cands.length <= n) return cands;
  const step = cands.length / n;
  return Array.from({ length: n }, (_, i) => cands[Math.floor(i * step)]);
}

async function profile(scope) {
  const idx = getIndex({ scope });
  if (!idx?.present || !idx.docs?.length) return null;
  const queries = selfQueries(idx.docs, SAMPLE);
  const scores = [], coverages = [];
  for (const q of queries) {
    const r = await search(q, { scope, limit: 3 });
    if (!r?.signals) continue;                 // degraded mode: no calibration possible
    scores.push(r.signals.topScore);
    coverages.push(r.signals.lexicalCoverage);
  }
  if (scores.length < 5) return null;
  return { n: scores.length, medianTopScore: r4(median(scores)), medianCoverage: r4(median(coverages)) };
}

const base = await profile('curated');
if (!base) { console.error('cannot profile the curated corpus — nothing to calibrate against'); process.exit(1); }

const corpora = { curated: { ...base, scoreFloor: RETRIEVAL.absence.scoreFloor, coverageFloor: RETRIEVAL.absence.coverageFloor, ratioScore: 1, ratioCoverage: 1 } };
for (const name of libraryCorpora()) {
  const p = await profile(name);
  if (!p) { console.log(`${name.padEnd(10)} skipped (no index, or too few usable self-queries)`); continue; }
  const rs = p.medianTopScore / base.medianTopScore;
  const rc = p.medianCoverage / base.medianCoverage;
  corpora[name] = {
    ...p,
    ratioScore: r4(rs), ratioCoverage: r4(rc),
    scoreFloor: r4(RETRIEVAL.absence.scoreFloor * rs),
    coverageFloor: r4(RETRIEVAL.absence.coverageFloor * rc)
  };
}

const out = {
  _meta: {
    generatedBy: 'scripts/derive-absence-floors.js',
    generatedAt: new Date().toISOString(),
    sample: SAMPLE,
    rule: 'Each floor is curated\'s, scaled by the ratio of this corpus\'s median to curated\'s median OF THE ' +
      'STATISTIC THAT FLOOR MEASURES (score floor by top-1 scores, coverage floor by lexical coverage), over ' +
      'self-derived queries (each document\'s own heading or description). phraseFloor and orphanFloor are ' +
      'NOT rescaled: both are already corpus-relative, and orphanShare is the fabricated-term detector.',
    curatedIsIdentity: 'curated re-derives to its shipped constants by construction (ratio 1.0) — asserted by the suite.',
    neverHandEdit: 'Regenerate with the script. A hand-tuned floor is a constant that has stopped being derived.'
  },
  corpora
};
const dest = arg('--out', join(ROOT, 'lib', 'absence-floors.json'));
writeFileSync(dest, JSON.stringify(out, null, 1) + '\n', 'utf8');

console.log(`\ncorpus      n   medianTop  medianCov   ratioS  ratioC   scoreFloor  coverageFloor`);
for (const [name, c] of Object.entries(corpora)) {
  console.log(`${name.padEnd(11)}${String(c.n).padEnd(4)}${String(c.medianTopScore).padEnd(11)}` +
    `${String(c.medianCoverage).padEnd(12)}${String(c.ratioScore).padEnd(8)}${String(c.ratioCoverage).padEnd(9)}` +
    `${String(c.scoreFloor).padEnd(12)}${c.coverageFloor}`);
}
console.log(`\n-> ${dest}\n`);
