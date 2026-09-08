// lib/reconcile.js — IS THE INDEX BEHIND THE STORE, AND MAY I REBUILD IT NOW?
//
// THE INCIDENT THIS SERVES (2026-09-05, 04:52Z). A hook wrote a store file and was killed before
// buildIndex ran. Four later ticks each logged an honest-looking `no-op` and 90 minutes of work
// stayed outside the index. WP2b answered it in scripts/auto-ingest.js: stop asking "did I write
// anything" and start asking "does the index's recorded source listing still match the store".
//
// 🟥 WHY THE LOGIC MOVED HERE (T-1, 2026-09-05). That answer lived inside auto-ingest's ingest
// block, which only runs when there is a TRANSCRIPT to ingest. scripts/timed-capture.mjs computed
// `forceReconcile` from the crash signature, PRINTED "forcing a reconcile pass", and then hit its
// `if (!active.length) … exit(0)` early return — so in the one shape the instrument was built for
// (every transcript already captured, index behind) the actuator was unreachable. Reproduced: store
// 5 → 6, index 5 → 5, the crash line printed, `RECONCILED? NO`.
//
// So the comparison is a function both callers can reach: the walker calls `reconcileIfBehind()`
// with no transcript in sight, and auto-ingest keeps using the same primitives inside its own
// branch structure (it has more to decide — whether the extractor wrote, whether a pending marker
// is owed — and one shared entry point would have flattened distinctions its run log depends on).
//
// NOTHING HERE THROWS ITS CALLER OVER. Both callers are unattended.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceListingOf } from './corpus.js';
import { indexHeaderOnDisk, buildIndex } from './index-store.js';
import { ownStoreDir, rootsForCorpus, stagingIndexPath } from './config.js';

/** Where the "a reconcile ran at" stamp lives. Same resolution auto-ingest has always used. */
export function reconcileStampPath(store = ownStoreDir()) {
  return process.env.MEMORY_RECONCILE_STAMP || (store ? join(store, '.last-reconcile.json') : null);
}

/** At most one reconcile rebuild per this many seconds, unless the evidence grew. */
export function reconcileMinSec() {
  return Number(process.env.MEMORY_RECONCILE_MIN_SEC ?? 120);
}

export function forceReconcileEnv() {
  return process.env.MEMORY_FORCE_RECONCILE === '1';
}

/**
 * WHY the index and the store disagree, or null when they do not.
 *
 * `crashPending` is the caller's own evidence (a dead run's .pending-index.json) and `force` the
 * crash signature read from the run log; both outrank the digest comparison because both mean
 * "somebody got as far as writing and not as far as indexing", which a digest cannot see once the
 * store and a STALE index happen to agree.
 */
export function reconcileReason({ liveListing, headerListing, crashPending = false, force = false }) {
  if (crashPending) return 'pending-marker';
  if (force) return 'crash-signature';
  if (!headerListing || typeof headerListing.digest !== 'string') return 'no-source-listing';
  if (headerListing.digest !== liveListing.digest) return 'listing-digest-mismatch';
  return null;
}

/** Read both sides of the comparison. Never throws: an unreadable index is "no listing". */
export function compareStoreToIndex(staging, idxPath) {
  const liveListing = sourceListingOf(staging);
  let headerListing = null;
  try { headerListing = indexHeaderOnDisk(idxPath)?.sourceListing || null; } catch { headerListing = null; }
  const indexFiles = Number.isFinite(headerListing?.count) ? headerListing.count : null;
  return { liveListing, headerListing, indexFiles };
}

/**
 * May a reconcile rebuild run right now?
 *
 * A rebuild is 14 s on the staging index and the timer fires every 5 minutes across every active
 * session. Ordinarily it self-limits — a successful rebuild stamps the listing, so the next tick
 * agrees and goes quiet. What does not self-limit is a mismatch the rebuild cannot clear, and that
 * is a storm indistinguishable from the tool working. Growth always wins over the clock: more
 * source files than the last reconcile saw means new material, and new material never waits.
 */
export function reconcileAllowed(liveListing, reason, { stampPath = reconcileStampPath(),
  minSec = reconcileMinSec(), force = forceReconcileEnv() } = {}) {
  if (!reason) return false;
  // A dead run's marker is a ONE-SHOT signal — cleared by the run that acts on it, so it cannot
  // storm, and deferring it defers the one case this mechanism exists for.
  if (reason === 'pending-marker') return true;
  let last = null;
  try { last = JSON.parse(readFileSync(stampPath, 'utf8')); } catch { last = null; }
  // 🟥 A CRASH SIGNATURE IS NOT ONE-SHOT, and this is what stops it becoming a storm (T-1).
  // lastRunCrashed() reads a `started` row with no terminal row after it; that row stays in the log
  // until it scrolls out of the 64 KB tail, so `force` is TRUE on every tick for as long as it is
  // there. That was harmless while the flag only reached children that had a transcript to ingest;
  // now the walker runs a pass on every idle tick too, and an unconditional rebuild would be 14 s
  // of work every 300 s for ever. So: once a reconcile has run over THIS EXACT listing digest, the
  // signature has been acted on and the same state does not earn a second rebuild. Any real change
  // in the store moves the digest and this returns true again on the very next tick.
  if (reason === 'crash-signature' && last && last.digest === liveListing.digest) return false;
  if (force || minSec <= 0) return true;
  if (!last || !Number.isFinite(last.at)) return true;
  if (liveListing.count > (last.count ?? 0)) return true;
  const age = (Date.now() - last.at) / 1000;
  // 🟥 A STAMP FROM THE FUTURE IS A CLOCK THAT MOVED, NOT A RECONCILE ABOUT TO HAPPEN (MEM-54).
  // A negative age is always < minSec, so the comparison below deferred the rebuild for the whole
  // clock offset -- and the growth escape hatch above cannot save it, because an EDIT changes the
  // digest without changing the count. Measured 2026-09-05 with a stamp one hour ahead and one
  // edited store file: `reconcile needed (listing-digest-mismatch) but one ran recently; deferring`
  // on every tick, the edit unindexed throughout. Same reading, same words, as
  // lib/scheduler.js shouldSpawn(): treat it as due. The cost of being wrong is one 14 s rebuild.
  if (age < 0) return true;
  return age >= minSec;
}

/** Record that a reconcile just ran over this listing. A missing stamp costs a redundant rebuild. */
export function stampReconcile(liveListing, stampPath = reconcileStampPath()) {
  if (!stampPath) return;
  try {
    writeFileSync(stampPath, JSON.stringify({ at: Date.now(),
      digest: liveListing.digest, count: liveListing.count }) + '\n', 'utf8');
  } catch { /* best effort */ }
}

/**
 * THE WHOLE PASS, for a caller with no transcript to ingest.
 *
 * @returns {{outcome:'agrees'|'debounced'|'reconciled'|'unavailable'|'failed',
 *            reason:string|null, storeFiles:number|null, indexFiles:number|null,
 *            indexedDocs?:number, indexedChunks?:number, error?:string}}
 */
export async function reconcileIfBehind({ staging = null, idxPath = null, force = forceReconcileEnv(),
  crashPending = false, stampPath = reconcileStampPath(), minSec = reconcileMinSec(), log = () => {} } = {}) {
  const roots = staging || rootsForCorpus('staging');
  const out = idxPath || stagingIndexPath();
  if (!out || !roots || !roots.length) return { outcome: 'unavailable', reason: null, storeFiles: null, indexFiles: null };
  try {
    const { liveListing, headerListing, indexFiles } = compareStoreToIndex(roots, out);
    const reason = reconcileReason({ liveListing, headerListing, crashPending, force });
    if (!reason) {
      log(`index agrees with the store (${liveListing.count} file(s)); untouched`);
      return { outcome: 'agrees', reason: null, storeFiles: liveListing.count, indexFiles };
    }
    if (!reconcileAllowed(liveListing, reason, { stampPath, minSec, force })) {
      log(`reconcile needed (${reason}) but one ran recently; deferring`);
      return { outcome: 'debounced', reason, storeFiles: liveListing.count, indexFiles };
    }
    log(`store and index disagree (${reason}); rebuilding staging index`);
    const report = await buildIndex({ dir: roots, out });
    stampReconcile(liveListing, stampPath);
    return { outcome: 'reconciled', reason, storeFiles: liveListing.count, indexFiles,
      indexedDocs: report.filesIndexed, indexedChunks: report.chunkCount };
  } catch (e) {
    // A reconcile that cannot run must not take the walker down with it: the per-session ingests
    // are the primary job and they have already happened (or been skipped) by the time this runs.
    return { outcome: 'failed', reason: null, storeFiles: null, indexFiles: null,
      error: String(e && e.message).slice(0, 300) };
  }
}
