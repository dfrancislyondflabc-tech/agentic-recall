// test/sandbox-env.js — the environment a spawned script is allowed to see.
//
// D2/D3, found by cross-account validation: suite group (a5) spawns the real
// scripts/dream.js and sandboxed four paths — MEMORY_DIR, MEMORY_OWN_STORE,
// MEMORY_INDEX, MEMORY_QUERY_LOG. Two production sidecars had been added since
// that list was written, and neither was in it, so every `npm test` silently
// overwrote:
//
//   .probe-results.json    with a zero-probe sweep of the fixture corpus,
//                          which turned OFF probe verdicts on search until
//                          someone ran a manual sweep. Two blind readers
//                          reached OPPOSITE conclusions about whether the
//                          probe feature works, on the same day, because one
//                          of them looked after a suite run.
//   .margin-history.jsonl  with rows whose every rank is null and every margin
//                          -1, which made the drift monitor difference today's
//                          real 0.0138 against a sentinel and print "+1.0138".
//
// THE POINT OF THIS FILE. The bug was not the two missing entries — it was
// that the list is maintained by memory in one call site. Every
// script-spawning test group now builds its env HERE, so a new sidecar is
// sandboxed by construction: add its variable to REDIRECTS once and every
// spawn inherits it.
//
// 🟥 IF YOU ADD A PATH-VALUED ENV VAR THAT A SCRIPT WRITES TO, ADD IT BELOW.
// The suite's own `(a65)` group asserts this list covers every writable path
// lib/config.js resolves, so forgetting is a test failure rather than a
// silent production write.

import { join } from 'node:path';

/**
 * Every env var that names a file a script may WRITE. Value is the basename
 * given to it inside the sandbox directory.
 */
export const REDIRECTS = Object.freeze({
  MEMORY_INDEX: 'index.json',
  MEMORY_STAGING_INDEX: 'staging-index.json',
  MEMORY_HANDOFF_INDEX: 'handoff-index.json',
  MEMORY_PROJECTS_INDEX: 'projects-index.json',
  MEMORY_LIBRARY_INDEX_DIR: '.',            // a DIRECTORY: the library index family
  MEMORY_QUERY_LOG: 'q.jsonl',
  MEMORY_PROBE_RESULTS: 'probe-results.json',
  MEMORY_MARGIN_HISTORY: 'margins.jsonl',
  MEMORY_VECTOR_CACHE: 'vector-cache.json',
  // 🟥 THE FOUR BELOW WERE MISSING, and two of them are the writers' own state. A spawned
  // scripts/auto-ingest.js appends to the REAL .ingest-runs.jsonl and buildIndex appends to the
  // REAL .vanish-report.jsonl unless these are redirected — the same class of leak the two entries
  // above this comment were added for. (a65)'s structural check only covers paths lib/config.js
  // resolves; these are resolved in the scripts themselves, so they need naming here explicitly.
  MEMORY_INGEST_LOG: 'ingest-runs.jsonl',
  MEMORY_VANISH_LOG: 'vanish-report.jsonl',
  MEMORY_PENDING_INDEX: 'pending-index.json',
  MEMORY_RECONCILE_STAMP: 'last-reconcile.json',
  // The recall canary (lib/recall-canary.js) writes two files, and a spawned scripts/timed-capture
  // .mjs runs it on every tick. Unredirected, `npm test` would append monitoring rows to the REAL
  // .recall-canary.jsonl and — worse — overwrite the REAL -state.json, whose whole job is to
  // remember which files have already reported their lag. Losing it silently re-seeds the canary
  // and it reports nothing for the files it was watching.
  MEMORY_RECALL_CANARY_LOG: 'recall-canary.jsonl',
  MEMORY_RECALL_CANARY_STATE: 'recall-canary-state.json',
  // The walker's own two files (lib/scheduler.js). A spawned scripts/timed-capture.mjs takes the
  // REAL .timed-capture.lock and stamps the REAL .timed-capture-last.json unless these are
  // redirected — which would do two things, both bad: a suite run would block the live LaunchAgent
  // for as long as the test walker held the lock, and it would tell every server on the machine
  // that a walk had just happened, suppressing real capture for the next five minutes.
  MEMORY_TIMED_CAPTURE_STAMP: 'timed-capture-last.json',
  MEMORY_TIMED_CAPTURE_LOCK: 'timed-capture.lock',
  // The audit tick's three (MEM-50, lib/scheduler.js + lib/store-snapshot.js). Same argument as the
  // walker's pair above, one step worse: an unredirected audit would take the REAL
  // .store-audit.lock, stamp the REAL .store-audit-last.json — suppressing the live audit for an
  // hour — and write a gzipped copy of the author's ENTIRE store into their real store directory on
  // every `npm test`.
  MEMORY_STORE_AUDIT_STAMP: 'store-audit-last.json',
  MEMORY_STORE_AUDIT_LOCK: 'store-audit.lock',
  MEMORY_STORE_SNAPSHOT_DIR: 'store-snapshots'
});

/**
 * The env for a spawned script: the real environment, plus the corpus roots
 * the caller wants, plus EVERY writable path pointed inside `tmp`.
 *
 * @param tmp    sandbox directory (already created)
 * @param extra  corpus/behaviour vars specific to the group (MEMORY_DIR, …)
 */
export function sandboxEnv(tmp, extra = {}) {
  const env = { ...process.env };
  for (const [key, base] of Object.entries(REDIRECTS)) {
    env[key] = base === '.' ? tmp : join(tmp, base);
  }
  return { ...env, ...extra };
}
