// lib/absence-floors.js — the absence floors, per corpus.
//
// `RETRIEVAL.absence` is four numbers calibrated on the curated corpus. They
// were applied unchanged to every library category, which breaks this repo's
// own law — constants do not travel between corpora — and it had a victim:
// asking a one-book corpus which oath the crews were re-sworn to returned
// "no strong match" while the answer sat verbatim in the returned snippet.
//
// The floors that MOVE are the two that measure a magnitude: `scoreFloor` and
// `coverageFloor`. The floors that STAY are the two that are already
// corpus-relative: `phraseFloor`, and `orphanFloor` — which is the
// fabricated-term detector, the thing that catches a question about a
// Concordat nobody ever wrote, and it must keep its full strength everywhere.
//
// Values come from `lib/absence-floors.json`, DERIVED by
// scripts/derive-absence-floors.js and never hand-edited. Curated re-derives
// to its own shipped constants by construction; the suite asserts it.
//
// Flag: MEMORY_CORPUS_ABSENCE_FLOORS. Default per the pre-registered bar in
// test/library-absence-floors-preregistration.md.

import { fileURLToPath } from 'node:url';
import { RETRIEVAL } from './config.js';
import { jsonFileMemo } from './file-memo.js';

// 🟥 D1, THE ONE THAT WAS LIVE. This used to be `if (TABLE) return TABLE`, so a
// server that started before the JSON was generated cached `{corpora:{}}`
// FOREVER and judged every library corpus by the curated floor — refusing
// questions whose answers were in the corpus, with no suite able to see it
// (each `npm test` is a fresh process that reads the file correctly).
// Memoized on the file's mtime+size instead, so the file appearing or changing
// under a running process is picked up on the next absence verdict. Cost: one
// stat per verdict on a 1.4 KB file.
const table = jsonFileMemo(
  () => fileURLToPath(new URL('./absence-floors.json', import.meta.url)),
  (text) => JSON.parse(text),
  () => ({ corpora: {} })
);
export const forgetFloorsMemo = () => table.forget();

// ON by default since the 2026-08-28 measurement met its pre-registered bar:
// the library casualty now answers (chapter-8 at rank 1, was a refusal with
// the answer in bestWeak), and every existing number held exactly —
// invented 12/12, manual 11/12, books 8/12, library absence 10/10, leaks 0,
// curated gold 10/10 / MRR 0.8833 / absence 4/4 / quotes 6/6.
// `0` restores the single global set. Numbers:
// test/library-absence-floors-preregistration.md.
export function corpusFloorsEnabled() {
  return !['0', 'false', 'off'].includes(String(process.env.MEMORY_CORPUS_ABSENCE_FLOORS || '').toLowerCase());
}

/**
 * The floors to judge THIS corpus by. Falls back to the shipped constants for
 * any corpus with no derived profile — an unmeasured corpus keeps the
 * conservative numbers rather than getting a guess.
 */
export function floorsFor(scope) {
  const base = RETRIEVAL.absence;
  if (!corpusFloorsEnabled()) return base;
  if (!scope || typeof scope !== 'string') return base;
  const derived = table().corpora?.[scope];
  if (!derived) return base;
  return {
    ...base,
    ...(Number.isFinite(derived.scoreFloor) ? { scoreFloor: derived.scoreFloor } : {}),
    ...(Number.isFinite(derived.coverageFloor) ? { coverageFloor: derived.coverageFloor } : {})
  };
}

/** For diagnostics: did this corpus get its own numbers, and which. */
export function floorsProvenance(scope) {
  const derived = corpusFloorsEnabled() ? table().corpora?.[scope] : null;
  return derived
    ? { derived: true, corpus: scope, medianTopScore: derived.medianTopScore, ratioScore: derived.ratioScore }
    : { derived: false, corpus: scope || null };
}
