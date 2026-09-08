#!/usr/bin/env node
// scripts/auto-ingest.js — the hook entry point. Ingest a finished conversation
// into the staging store and refresh the staging index.
//
//   node scripts/auto-ingest.js [transcript.jsonl]      (default: most recent)
//
// Designed to be fired by a SessionEnd hook and to be BORING when there is
// nothing to do: it exits in milliseconds if the transcript is already ingested.
//
// FOUR THINGS THAT MAKE THIS SAFE TO RUN UNATTENDED
//
// 1. It only ever writes to the STAGING store and the STAGING index. The curated
//    corpus and its index are never opened for writing. That boundary is what
//    the 2026-08-17 measurement bought: mixing the two costs three memories
//    their answer and 0.145 MRR, keeping them apart costs nothing at all.
// 2. Tool traffic never reaches disk. The extractor drops tool_use/tool_result
//    and thinking blocks, which is where every credential in 50 MB of measured
//    transcript actually lived.
// 3. A LOCK. Two sessions can end within a second of each other; a half-written
//    index is worse than a stale one. Second runner exits rather than queues.
// 4. It is INCREMENTAL twice over — the extractor skips exchanges whose file is
//    byte-identical, and buildIndex reuses vectors by mtime+hash — so the steady
//    state is "a few new documents", not "re-embed the world".

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncHidden } from '../lib/child.js';   // 🟥 MEM-83: THE per-response popup (Stop hook)
import { renameWithRetry } from '../lib/fs-retry.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- THE LOG IS ARMED BEFORE ANYTHING THAT CAN THROW ------------------------------------------
//
// Reviewed 2026-09-03 (MEM-20/F7): a throw during the lib imports, or in homedir() at module level
// (seen: ENOBUFS from an oversized HOME), exited non-zero having written NOTHING -- and the hook host
// discards stderr, so the run left no trace at all. The log path is therefore resolved here, from the
// environment alone, and the exit handler registered, BEFORE the libraries are imported. The imports
// are dynamic and guarded so an import failure is a logged `failed`, not silence. If lib/config.js
// later resolves a different store, the path is switched then.
const TIMED = process.argv.includes('--timed') || process.env.MEMORY_INGEST_TIMED === '1';
let RUN_LOG = process.env.MEMORY_INGEST_LOG
  || join(process.env.MEMORY_OWN_STORE || join(process.env.MEMORY_ROOT || ROOT, 'store'), '.ingest-runs.jsonl');
const RUN_LOG_MAX = Number(process.env.MEMORY_INGEST_LOG_MAX_BYTES ?? 2 * 1024 * 1024);
let runLogged = false;
let sessionForLog = null;
function runLog(outcome, extra = {}) {
  // `started` is the one line allowed BEFORE the terminal one: a run killed mid-way (the walker's
  // 10-minute SIGTERM, a host quitting) then leaves `started` with no `captured`/`no-op`/`failed`
  // after it, which is the crash signature the next reader can look for.
  // `started`, `crash-recovered` and `swept` are the three lines allowed BEFORE the terminal one: a
  // run killed mid-way then leaves `started` with no `captured`/`no-op`/`failed` after it, which is
  // the crash signature the next reader can look for -- and `crash-recovered` is that next reader
  // SAYING SO, which must not consume the terminal line describing what this run then did about it.
  // `swept` (MEM-55) names the debris of an earlier death and likewise describes housekeeping, not
  // the outcome of THIS run.
  if (outcome !== 'started' && outcome !== 'crash-recovered' && outcome !== 'swept') {
    if (runLogged) return;              // one terminal line per run, whichever exit is reached first
    runLogged = true;
  }
  if (!RUN_LOG) return;
  try {
    // renameWithRetry, not renameSync: on Windows a rotate fails with EPERM while anything holds
    // either path open — a virus scanner, or one of the several capture processes reading this very
    // log. A failed rotate is silent here, so the symptom would be a run log that grows forever.
    try { if (statSync(RUN_LOG).size > RUN_LOG_MAX) renameWithRetry(RUN_LOG, RUN_LOG + '.1'); } catch (_) { /* first run */ }
    try { mkdirSync(dirname(RUN_LOG), { recursive: true }); } catch (_) { /* exists */ }
    appendFileSync(RUN_LOG, JSON.stringify({
      at: new Date().toISOString(),
      trigger: TIMED ? 'timed' : 'hook',
      outcome,
      pid: process.pid,
      ...(sessionForLog ? { session: sessionForLog } : {}),
      ...extra
    }) + '\n', 'utf8');
  } catch (_) { /* a log that cannot be written must never fail an ingest */ }
}
process.on('exit', () => runLog('exited', {}));

let ownStoreDir, stagingIndexPath, memoryRoots, rootsForCorpus, localConfig, connectorRecentlyOn, buildIndex, homedir,
    compareStoreToIndex, reconcileReason, reconcileAllowed, stampReconcile, reconcileStampPath, reconcileMinSec,
    forceReconcileEnv, excludedSessionReason;
try {
  ({ homedir } = await import('node:os'));
  ({ excludedSessionReason } = await import('../lib/capturable.js'));
  ({ ownStoreDir, stagingIndexPath, memoryRoots, rootsForCorpus } = await import('../lib/config.js'));
  ({ localConfig } = await import('../lib/local-config.js'));
  ({ connectorRecentlyOn } = await import('../lib/heartbeat.js'));
  ({ buildIndex } = await import('../lib/index-store.js'));
  ({ compareStoreToIndex, reconcileReason, reconcileAllowed, stampReconcile, reconcileStampPath,
     reconcileMinSec, forceReconcileEnv } = await import('../lib/reconcile.js'));
  if (!process.env.MEMORY_INGEST_LOG && ownStoreDir()) RUN_LOG = join(ownStoreDir(), '.ingest-runs.jsonl');
} catch (e) {
  console.error('[auto-ingest] FAILED before start:', e.message);
  runLog('failed', { error: 'startup: ' + String(e.message).slice(0, 280) });
  process.exit(1);
}
// EVERY project directory, not one. Claude keeps a transcript folder per
// project, so a hook hard-wired to a single folder silently ignores sessions
// from any other project — and then its "most recent" fallback re-scans an
// unrelated transcript, which looks like success. Found by asking what happens
// when two chats run at once: this machine has two project dirs.
// homedir(), not process.env.HOME: HOME is not set on Windows (it uses
// USERPROFILE), so this would have been join(undefined, ...) and thrown on
// every single turn -- taking transcript capture down with it.
const PROJECT_ROOT = join(homedir(), '.claude', 'projects');
const projectDirs = () => {
  if (process.env.MEMORY_TRANSCRIPT_DIR) return [process.env.MEMORY_TRANSCRIPT_DIR];
  try {
    return readdirSync(PROJECT_ROOT).map((d) => join(PROJECT_ROOT, d)).filter((d) => existsSync(d));
  } catch (_) { return []; }
};

// ---- TIMED vs HOOK: provisional versus final -------------------------------------------------
//
// A hook run happens when a turn ENDS, so every exchange in the transcript is finished and all of
// them are captured. A TIMED run happens mid-turn, so the last exchange is still being written —
// ingest-transcript.js pairs "one user turn + everything the assistant said before the next user
// turn", which makes the in-flight exchange exactly the one with no following user turn.
//
// A timed run therefore DEFERS the final exchange to the next pass. Not for safety — a partial is
// self-correcting, because the writer overwrites whenever content differs — but because a growing
// exchange rewritten every interval is re-embedded every interval, and a truncated answer is
// briefly searchable as though it were complete.
//
// 🟥 The hook must NOT defer. Dropping the last exchange there would lose the final exchange of
// every session, since no further user turn ever arrives.
// (TIMED is defined above, before the log is armed.)

const log = (...a) => console.error('[auto-ingest]', ...a);

// ---- A RUN LEAVES A TRACE ---------------------------------------------------------------------
//
// Everything above logs to stderr, which the hook host discards. So when the staging index turned
// out to be five hours stale, there was no way to tell whether this had run and skipped, run and
// failed, or never run at all — the question was unanswerable by the one instrument that could
// have answered it. One line per run, appended, so the next occurrence is diagnosable.
//
// Every field is an OUTCOME, not a narration: a reader wants to know what happened, not what the
// script was thinking. `why` is present exactly when nothing was written.
// (RUN_LOG, runLog() and the exit handler are defined at the top of the file, BEFORE the library
// imports, so that a failure during startup still leaves a line. `session` is set on every line once
// the transcript is resolved: the walker fires one run per active session and three are usually
// live, so a line without it could not be attributed to a conversation.)

/** A session id resolves to its own transcript wherever it lives. */
function resolveTranscript(arg) {
  if (arg && existsSync(arg)) return arg;                    // an explicit path
  if (arg) {                                                 // a bare session id
    const sid = arg.replace(/\.jsonl$/, '');
    for (const d of projectDirs()) {
      const cand = join(d, `${sid}.jsonl`);
      if (existsSync(cand)) return cand;
    }
    log(`session ${sid} not found in any project dir; falling back to most recent`);
  }
  const all = [];
  for (const d of projectDirs()) {
    let names = []; try { names = readdirSync(d); } catch (_) { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(d, f);
      try { all.push({ p: full, m: statSync(full).mtimeMs }); } catch (_) { /* skip */ }
    }
  }
  all.sort((a, b) => b.m - a.m);
  return all.length ? all[0].p : null;
}

/**
 * The session id, from argv OR from the hook's own JSON on stdin.
 *
 * The Mac hook was `jq -r '.session_id' | { read -r sid; node auto-ingest.js "$sid"; }`
 * -- which needs jq, a POSIX pipe and a POSIX shell, none of which exist on
 * Windows. Reading stdin here instead makes the hook a bare `node auto-ingest.js`
 * that is byte-identical on both platforms, and drops an external dependency.
 *
 * readFileSync(0) is a synchronous read of fd 0. It is guarded three ways: skipped
 * when stdin is a TTY (an interactive run has no hook JSON and would block
 * forever), wrapped so a closed or empty stdin is not an error, and tolerant of
 * non-JSON. Falling through to `undefined` is harmless -- resolveTranscript()
 * already falls back to the most recently modified transcript.
 */
function sessionIdFromStdin() {
  try {
    if (process.stdin.isTTY) return undefined;
    const raw = readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return undefined;
    const j = JSON.parse(raw);
    return j.session_id || j.sessionId || undefined;
  } catch (_) { return undefined; }
}

// WHICH SESSIONS GET REMEMBERED, and how you change your mind about it.
//
// DEFAULT: the ones you had the memory connector switched ON for. That toggle is already in
// Claude's UI, everyone can find it, and it has a physical consequence this hook can observe —
// an enabled connector means this server is running and leaving a dated mark. So the switch
// people already use becomes the switch, with no hook JSON to edit and nothing invisible.
//
// Two overrides, both in local-config.json because a HOOK INHERITS NO ENVIRONMENT — that is
// the whole reason lib/local-config.js exists, and an env-var-only switch would silently do
// nothing here:
//
//   { "captureAlways": true }   remember every session, connector on or off
//   { "autoIngest": false }     remember nothing, ever
//
// Env vars are honoured too, for a one-off manual run: MEMORY_AUTO_INGEST=0 | 1 | always.
// THE SESSION IS NAMED BEFORE THE FIRST EXIT, NOT AFTER IT (MEM-78). Every `skipped` row used to
// be written before `sessionForLog` was set, so the run log recorded refusals nobody could attribute
// to a conversation -- 0 of the scheduled-task sessions' ids appear in any row, which is precisely
// why `uncapturedSessions` could go on naming them as pending for ever with nothing to contradict
// it. The id is read from argv or the hook's stdin here (one read of fd 0, reused below), and
// re-derived from the resolved transcript once that is known.
const SESSION_ARG = process.argv[2] || sessionIdFromStdin();
if (SESSION_ARG) sessionForLog = String(SESSION_ARG).replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');

const AI_ENV = String(process.env.MEMORY_AUTO_INGEST ?? '').toLowerCase();
if (AI_ENV === '0' || localConfig().autoIngest === false) process.exit(0);
const CAPTURE_ALWAYS = AI_ENV === 'always' || AI_ENV === '1' || localConfig().captureAlways === true;
if (!CAPTURE_ALWAYS) {
  const hb = connectorRecentlyOn();
  if (!hb.on) {
    // Silent and exit 0: a session you had memory switched off for is not an error, and a hook
    // that prints on every ordinary session end is a hook people delete.
    runLog('skipped', { why: 'memory connector not recently on (heartbeat cold)' });
      process.exit(0);
  }
}

const transcript = resolveTranscript(SESSION_ARG);
if (!transcript || !existsSync(transcript)) { log('no transcript; nothing to do'); runLog('skipped', { why: 'no transcript' }); process.exit(0); }
// The resolved transcript is the authority on which session this run is about -- argv may have been
// a bare id, or absent entirely (the "most recent" fallback). Set BEFORE the exclusion check below,
// so the row that refuses a session names it (MEM-78).
sessionForLog = String(transcript).replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');

// ---- IS THIS A CONVERSATION AT ALL? (MEM-78) --------------------------------------------------
//
// The scheduled-task test used to live here, as a private function, and that was the defect: the
// WRITER refused those sessions, the READER (lib/capture-status.js) counted them as "uncaptured,
// the next tick will get them" and the SELECTOR (scripts/timed-capture.mjs) queued them into its
// eight slots per tick — three components with three answers because there was one rule in one
// file. It is now lib/capturable.js, imported by all three, and the row this run writes carries the
// session id so the refusal can be attributed at all (0 of the four scheduled-task sessions on this
// machine appeared in any run-log row before).
const excluded = excludedSessionReason(transcript);
if (excluded) {
  log(`${excluded} session; not a conversation, nothing to remember`);
  runLog('skipped', { why: `${excluded} session` });
  process.exit(0);
}

const store = ownStoreDir();
const stagingIdx = stagingIndexPath();
if (!store || !stagingIdx) { log('staging disabled; nothing to do'); process.exit(0); }
mkdirSync(store, { recursive: true });

// ---- DEBOUNCE (BEFORE THE LOCK, DELIBERATELY) -------------------------------------------------------------
// SessionEnd is not enough. It fires on exit/clear/logout/resume, and a chat
// left open for DAYS never fires it — so the work in the session you actually
// live in is the work that never gets captured. A Stop hook fires after every
// assistant turn and closes that gap, but a turn-by-turn full re-parse is not
// free: a 100 MB transcript takes ~60s to walk. So a per-transcript stamp keeps
// the common case to a stat() and an early exit.
// Override with MEMORY_INGEST_DEBOUNCE_SEC; 0 disables.
const DEBOUNCE_SEC = Number(process.env.MEMORY_INGEST_DEBOUNCE_SEC ?? 600);
// HOW LONG A TRANSCRIPT MUST SIT STILL BEFORE THE TIMER STOPS TREATING ITS LAST EXCHANGE AS LIVE.
// 10 minutes: long enough that a slow tool call, a long generation or a coffee break does not get a
// half-written reply written and re-embedded, short enough that the no-hook worst case is one audit
// grace period rather than one audit interval. Below it nothing changes; above it the timer behaves
// like the hook. `0` captures the in-flight exchange on every tick; `off` restores the pre-1.7.2
// unconditional deferral, which is the kill switch if MEM-67's cure ever costs more than the defect.
const INFLIGHT_QUIET_MS = (() => {
  const raw = String(process.env.MEMORY_INFLIGHT_QUIET_MIN ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'never') return null;
  const n = parseFloat(raw);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 60_000;
})();
// A WINDOWED RUN CONSIDERS A SLICE, NOT THE FILE. The MCP `capture` action passes this through
// (tools/memory.js doCapture), and `scripts/ingest-transcript.js --since-minutes` reads the same
// variable. Read here so the `finally` below knows not to stamp — see the comment there.
const WINDOWED = (() => {
  const n = parseFloat(process.env.MEMORY_INGEST_SINCE_MINUTES);
  return Number.isFinite(n) && n > 0;
})();
const stampFile = join(store, '.last-ingest.json');
const readStamps = () => { try { return JSON.parse(readFileSync(stampFile, 'utf8')); } catch { return {}; } };
const stamps = readStamps();
const txKey = transcript;
if (DEBOUNCE_SEC > 0 && stamps[txKey]) {
  const sinceRun = (Date.now() - stamps[txKey].at) / 1000;
  let size = 0; try { size = statSync(transcript).size; } catch (_) { /* ignore */ }
  // 🟥 A STAMP FROM THE FUTURE IS A CLOCK THAT MOVED, NOT A RUN ABOUT TO HAPPEN (MEM-53).
  // A negative `sinceRun` is always < DEBOUNCE_SEC, so the unguarded comparison below skipped the
  // run -- and this exit is BEFORE the lock, before the extractor and before the store-vs-index
  // reconcile, so a timezone fix, an NTP correction, a VM resume or a dual-boot RTC stopped capture
  // AND reconcile for that transcript for the whole offset. Measured 2026-09-05 with a stamp one
  // hour ahead: `nothing new since -3600s ago`, and a store file that landed after the last build
  // stayed out of the index (4 docs, 5 store files). The rule is the one lib/scheduler.js
  // shouldSpawn() already applies to the walker stamp: treat it as "never ran". The cost of being
  // wrong is one redundant parse behind the lock; the cost of the other choice is hours of silence.
  if (sinceRun < 0) {
    log(`debounce stamp from the future — clock moved; ignoring it (${Math.round(-sinceRun)}s ahead)`);
  } else if (sinceRun < DEBOUNCE_SEC && size === stamps[txKey].size && !stamps[txKey].deferred) {
    // Skip only if BOTH little time has passed AND the transcript has not grown.
    // Growth is the real signal; the clock alone would drop a burst of work.
    //
    // 🟥 AND ONLY IF THE LAST RUN LEFT NOTHING BEHIND (MEM-67). A run that deferred the in-flight
    // exchange did NOT capture this size, whatever the stamp's number says — and "the transcript
    // has not grown" is precisely the state an abandoned turn stays in for ever. Skipping on it is
    // how the deferral became permanent. `deferred` costs at most two extra parses per abandoned
    // turn: one while it is still inside the quiet threshold, one that captures it and clears the
    // flag.
    log(`nothing new since ${sinceRun.toFixed(0)}s ago (transcript unchanged); skipping`);
    runLog('skipped', { why: 'debounced: transcript unchanged', sinceSec: Math.round(sinceRun) });
    process.exit(0);
  }
}

// The debounce runs BEFORE the lock is taken. It used to run after, and its
// early exit skipped the `finally` that releases the lock -- reintroducing the
// exact leak fixed one commit earlier. Deciding to do nothing should never
// require holding a lock.
// ---- the lock -------------------------------------------------------------
// A LOCK HELD BY A DEAD PROCESS IS NOT A LOCK. Observed on the first real
// SessionEnd firing: the hook is async, the app was quitting, and the host
// killed the ingest mid-run. The `finally` cleanup never got to run, so the
// lock survived with a pid that no longer existed — and the age-only rule would
// have blocked the NEXT session's ingest for 28 more minutes for no reason.
// Age is the fallback; liveness is the real test.
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

const lock = join(store, '.auto-ingest.lock');
// ATOMIC, OR IT IS NOT A LOCK. `existsSync` then `writeFileSync` is a check-then-act gap: measured
// with a hook and a timed run started together, 20 trials -- both proceeded 8 times, and 6 of those
// left the index one document short of the store while BOTH log lines said "captured". `wx` makes
// creation the test; the liveness check runs only when creation fails.
const tryLock = () => { try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
if (!tryLock()) {
  let age = 0, holder = NaN;
  try { age = (Date.now() - statSync(lock).mtimeMs) / 1000; } catch (_) { /* vanished between the two calls */ }
  try { holder = parseInt(readFileSync(lock, 'utf8').trim(), 10); } catch (_) { /* unreadable = treat as dead */ }
  if (processAlive(holder)) {
    log(`another run (pid ${holder}) holds the lock; exiting`);
    runLog('skipped', { why: `lock held by live pid ${holder}` });
    process.exit(0);
  }
  log(`lock held by dead pid ${holder || '?'} (${age.toFixed(0)}s old); taking it`);
  try { unlinkSync(lock); } catch (_) { /* someone else already cleared it */ }
  if (!tryLock()) {                     // lost the race to another run that saw the same dead pid
    log('lock taken by another run while clearing a dead one; exiting');
    runLog('skipped', { why: 'lock raced' });
    process.exit(0);
  }
}

// ---- SWEEP THE DEBRIS OF A KILLED WRITER (MEM-55) --------------------------------------------
//
// scripts/ingest-transcript.js:685 writes `<name>.md.<pid>.tmp` and renames it into place (MEM-34's
// atomic write). A SIGKILL between the two leaves the temp behind for ever: `listCorpusFiles`
// filters on `.md`, so it is correctly invisible to retrieval, and lib/index-store.js's age-based
// sweep only covers `<index>.<pid>.tmp` in the INDEX directory. Nothing swept the STORE and nothing
// said the words -- silent, unbounded disk growth. Reproduced 2026-09-05: a planted temp survived a
// full reconcile pass with `index agrees with the store, untouched` in the log.
//
// The pattern is `<anything>.<pid>.tmp`, not `*.md.<pid>.tmp`, because that suffix is this
// project's one convention for "a half-written file owned by a pid" — the exchange writer, the
// index writer (lib/index-store.js:526) and the scheduler's stamps (lib/scheduler.js, MEM-57) all
// use it — and a sweep that knew only about exchanges would leave the others to accumulate.
//
// TWO TESTS, NOT ONE, and they catch different things. Liveness is the precise test — a temp whose
// pid is gone can never be completed — but a pid is meaningless across a reboot or a shared volume,
// so AGE is the backstop: a real write of a single exchange is milliseconds, and ten minutes of
// margin cannot race one. A LIVE pid's temp inside that window is left strictly alone; that is
// another writer mid-rename, and deleting it would be this script causing the very loss it is
// cleaning up after. Best effort throughout: a sweep that cannot read the directory must never stop
// the ingest that was actually asked for. It runs behind the lock, so two runs cannot sweep at once.
const TMP_MAX_AGE_MS = Number(process.env.MEMORY_STORE_TMP_MAX_AGE_MS ?? 600_000);
try {
  const swept = [];
  for (const f of readdirSync(store)) {
    const m = /^(.+)\.(\d+)\.tmp$/.exec(f);
    if (!m) continue;
    const pid = parseInt(m[2], 10);
    let ageMs = Infinity; try { ageMs = Date.now() - statSync(join(store, f)).mtimeMs; } catch (_) { /* vanished */ }
    if (processAlive(pid) && ageMs < TMP_MAX_AGE_MS) continue;     // a writer mid-rename: hands off
    try { unlinkSync(join(store, f)); swept.push(f); } catch (_) { /* someone else got there first */ }
  }
  if (swept.length) {
    log(`swept ${swept.length} orphaned store temp file(s) left by a killed writer`);
    runLog('swept', { files: swept.slice(0, 20), count: swept.length });
  }
} catch (_) { /* a sweep that fails leaves the ingest untouched */ }

// ---- WP2b: A DEBOUNCE ON RECONCILE-TRIGGERED REBUILDS -----------------------------------------
//
// A reconcile rebuild is 14 seconds on the staging index, and the timer fires every 5 minutes
// across every active session. Ordinarily it self-limits -- a successful rebuild stamps the current
// listing into the header, so the next tick's digests agree and it goes quiet. What does NOT
// self-limit is a mismatch the rebuild cannot clear: a file being appended to continuously, a
// corpus root that keeps changing under the build, a write that fails the same way every time. That
// is a rebuild storm, and it would be indistinguishable from the tool working.
//
// So: at most one reconcile rebuild per MEMORY_RECONCILE_MIN_SEC (default 120) -- UNLESS the
// evidence GREW. More source files than the last reconcile saw means new material, and new material
// must never wait behind a clock. Growth wins over the debounce, which is the same rule the
// transcript debounce above already uses.
// 🟥 THE RULES THEMSELVES NOW LIVE IN lib/reconcile.js (T-1, 2026-09-05), because this file was
// the only place that could reach them and this file only runs when there is a TRANSCRIPT to
// ingest. scripts/timed-capture.mjs could detect a crashed run and print "forcing a reconcile
// pass" and then reach nothing at all, because its `!active.length` early return fires first —
// the exact 04:52Z shape. Same predicates, same stamp, one implementation, two callers.
const RECONCILE_MIN_SEC = reconcileMinSec();
const FORCE_RECONCILE = forceReconcileEnv();
const reconcileStamp = reconcileStampPath(store);
const reconcileOpts = { stampPath: reconcileStamp, minSec: RECONCILE_MIN_SEC, force: FORCE_RECONCILE };

// ---- WP2c: DID THE PREVIOUS RUN DIE BETWEEN WRITING FILES AND BUILDING THE INDEX? -------------
//
// THE INCIDENT (2026-09-05, 04:52Z). The hook wrote store/x-b58a69af-20260905T044521647Z.md and was
// killed by the host before buildIndex ran. The run log holds `started` then a bare `exited`. The
// next timed run compared the store against ITS OWN run, found nothing new, logged "index
// untouched" -- and 90 minutes of work was absent from every answer, with nothing anywhere saying
// so. The gap is that nothing marked the interval between "files written" and "index rebuilt".
//
// So mark it. A file on disk for the duration of that window, carrying the pid that owns it. A
// later run that finds it with a pid that is not alive knows, without inference, that some run got
// as far as writing and never got as far as indexing -- and reconciles instead of trusting a count.
//
// Removed in `finally` ONLY on success: a failed run's window is still open, and clearing the
// marker would be the script asserting the thing it just failed to do.
const pendingPath = process.env.MEMORY_PENDING_INDEX || join(store, '.pending-index.json');
let crashPending = null;
try {
  const p = JSON.parse(readFileSync(pendingPath, 'utf8'));
  if (p && p.pid !== process.pid && !processAlive(p.pid)) crashPending = p;
} catch (_) { /* absent, unreadable or half-written: no marker is not a crash */ }

// THE DEBOUNCE STAMP RECORDS THE SIZE THE EXTRACTOR READ, not the size when it finished. Stamping
// afterwards recorded anything appended DURING the run as already captured: reproduced -- an exchange
// appended 1.5 s into a 5 s run was in no store file, and the next two runs said "transcript
// unchanged". Read the size here, before the extractor does, and stamp exactly that.
let sizeAtStart = 0; try { sizeAtStart = statSync(transcript).size; } catch (_) { /* ignore */ }
let failed = false;
// Set from the extractor's own report below, and written into the debounce stamp (MEM-67).
let deferredInFlight = false;
// A `started` line with no terminal line after it is the signature of a run that was killed.
runLog('started', { transcriptBytes: sizeAtStart });
if (crashPending) {
  log(`a previous run (pid ${crashPending.pid}) wrote files and never indexed them; reconciling`);
  runLog('crash-recovered', { deadPid: crashPending.pid, pendingAt: crashPending.at,
    pendingSession: crashPending.session ?? null, pendingTranscriptBytes: crashPending.transcriptBytes ?? null });
}
try { writeFileSync(pendingPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
  session: sessionForLog, transcriptBytes: sizeAtStart }) + '\n', 'utf8'); } catch (_) { /* a marker that cannot be written must not stop an ingest */ }

try {
  const before = existsSync(store) ? readdirSync(store).filter((f) => f.endsWith('.md')).length : 0;

  // A timed run is PROVISIONAL WHILE THE TURN IS LIVE, and only while it is live. The in-flight
  // exchange waits for the next pass rather than being written and re-embedded on every interval —
  // but a transcript that has not moved for MEMORY_INFLIGHT_QUIET_MIN minutes is a turn that is over
  // or abandoned, and deferring THAT one is how the final exchange of a hook-less install went
  // uncaptured until the hourly store audit healed it (MEM-67: ~14 min measured on the Windows PC,
  // ~75 min worst case). Past the quiet threshold the timer captures it exactly as the hook would,
  // stamped `inFlight: true`. The hook still never defers at all.
  const stdout = execFileSyncHidden(process.execPath, [join(ROOT, 'scripts/ingest-transcript.js'), transcript, '--write',
    ...(TIMED ? (INFLIGHT_QUIET_MS === null ? ['--defer-last']
                                            : ['--defer-last-unless-quiet-ms', String(INFLIGHT_QUIET_MS)]) : [])],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).toString();

  // NO process.exit() INSIDE THIS TRY. process.exit() does not run `finally`,
  // so the early return for "nothing new" leaked the lock on every quiet run --
  // which is the COMMON case. The next run then found a lock held by a dead pid;
  // the liveness check above recovers from that, so the two defects masked each
  // other and only a fixture that asserted the lock was CLEARED could see it.
  //
  // A REWRITE COUNTS. This used to compare file COUNTS only, so an existing exchange whose content
  // changed -- the extractor learned to see something it had missed (1.5.1: mid-turn messages), or
  // an exchange was captured provisionally and then completed -- left the index describing the OLD
  // text until some later capture happened to add a file. The extractor reports what it wrote;
  // read that instead of inferring it from a count that cannot see a rewrite.
  const after = readdirSync(store).filter((f) => f.endsWith('.md')).length;
  const wrote = parseInt((/^wrote (\d+),/m.exec(stdout) || [])[1] || '0', 10);
  // A REWRITE IS NOT NOTHING (MEM-71a). `wrote` counts every file this run put on disk; the ones
  // that were not there before are new exchanges, and the remainder are exchanges whose text
  // CHANGED — overwhelmingly the in-flight one being refreshed with more of the reply. The two are
  // reported separately from here down, because a caller told "0" about a refresh reads it as
  // "nothing happened" and waits for a capture that has already occurred.
  const newExchanges = Math.max(0, after - before);
  const rewritten = Math.max(0, wrote - newExchanges);
  // DID THIS RUN LEAVE THE IN-FLIGHT EXCHANGE BEHIND? The stamp below claims "this size was
  // captured", and after a deferral that claim is false by exactly one exchange — the newest one.
  // Recorded so the two skip rules that read the stamp (the debounce above, and the walker's
  // selector in scripts/timed-capture.mjs) know there is still work here even though the file has
  // stopped growing. Without it the extractor's new quiet rule could never fire: nothing would ever
  // run the extractor again.
  deferredInFlight = /^deferring the in-flight exchange/m.test(stdout);

  // ---- WP2b: THE NO-OP TEST NOW ASKS THE INDEX, NOT THIS RUN -----------------------------------
  //
  // 🟥 THE DEFECT THIS REPLACES. "Did I write anything?" is not the same question as "is the index
  // current?", and the old test only asked the first. Every failure mode where SOMEONE ELSE'S write
  // never reached the index -- a run killed before buildIndex, a build that threw, an index deleted
  // or restored from a backup -- looked exactly like a quiet tick, and this line printed "index
  // untouched" over the top of it. Measured on 2026-09-05: a store file written at 04:52Z was still
  // outside the index at 06:20Z with four honest-looking `no-op` lines in between.
  //
  // The store is the truth and the index is a cache, so compare them: a stat pass over the corpus
  // (~9 ms on 2,104 files, lib/freshness.js has the measurement) digested to one string, against
  // the digest the index recorded when it was built (lib/index-store.js expectedHeader). Equal
  // digests are the ONLY thing that earns a no-op.
  //
  // An index whose header predates that field returns no listing, and a check that cannot tell must
  // reconcile rather than assume -- once, because the rebuild it triggers writes the field.
  const staging = rootsForCorpus('staging');
  const extractorWrote = !(after === before && wrote === 0);
  const { liveListing, headerListing, indexFiles } = compareStoreToIndex(staging, stagingIdx);
  const reason = reconcileReason({ liveListing, headerListing, crashPending: !!crashPending, force: FORCE_RECONCILE });

  if (!extractorWrote && !reason) {
    log(`no new exchanges (${after} in store); index agrees with the store, untouched`);
    runLog('no-op', { why: 'no new exchanges', storeFiles: after, indexFiles });
  } else if (!extractorWrote && !reconcileAllowed(liveListing, reason, reconcileOpts)) {
    // Debounced. Named as its own outcome so a reader can tell a suppressed reconcile from a
    // genuinely quiet tick -- the two used to be indistinguishable, which is how this started.
    log(`reconcile needed (${reason}) but one ran recently; deferring`);
    runLog('skipped', { why: `reconcile debounced (${reason})`, storeFiles: after, indexFiles });
  } else if (!extractorWrote) {
    log(`store and index disagree (${reason}); rebuilding staging index`);
    const report = await buildIndex({ dir: staging, out: stagingIdx });
    stampReconcile(liveListing, reconcileStamp);
    runLog('reconciled', { reason, storeFiles: after, indexFiles,
      indexedDocs: report.filesIndexed, indexedChunks: report.chunkCount });
  } else {
    log(`${newExchanges} new exchange(s)${rewritten ? `, ${rewritten} rewritten` : ''}; refreshing staging index`);
    // `staging` above is rootsForCorpus('staging'), NOT !primary. There are three corpora now, and
    // the handoff roots are also non-primary — `!primary` would have quietly written the handoff
    // documents into the staging index, which is the exact blending this architecture exists to
    // prevent.
    const report = await buildIndex({ dir: staging, out: stagingIdx });
    stampReconcile(liveListing, reconcileStamp);
    // 🟥 REPORT THE INDEX, NOT THE STORE. `report.fileCount` and `report.chunks` are fields
    // buildIndex has never returned — it returns `filesIndexed` and `chunkCount` (lib/index-store.js
    // :523,527). Both reads were therefore always `undefined`, and the `?? after` fallback quietly
    // substituted the STORE count. So the one line whose job is to compare the two sides printed the
    // same number on both sides of its own comparison, and `indexedChunks` was null on every run
    // ever logged. A telemetry field that cannot disagree with itself measures nothing.
    log(`staging index: ${report.filesIndexed} docs, ${report.chunkCount} chunks`);
    runLog('captured', { newExchanges, ...(rewritten ? { rewritten } : {}), storeFiles: after,
      indexedDocs: report.filesIndexed, indexedChunks: report.chunkCount });
  }
  // ---- ONE LINE A CALLER CAN PARSE (MEM-71a) ---------------------------------------------------
  //
  // 🟥 `tools/memory.js doCapture` read `emitted: N` out of this run's output to fill
  // `exchangesCaptured` — and this script has never printed that line. The extractor prints it, on
  // ITS stdout, which execFileSync above captures into a variable and never re-emits. So the number
  // the Windows tester read was not "wrong for a rewrite": `exchangesCaptured` was structurally 0 on
  // every capture that has ever run, and no test caught it because every assertion checked only that
  // the field was a number. One deliberate, stable line, printed on every path including the quiet
  // ones, so the reader is told what happened rather than what the parser failed to find.
  log(`summary: new=${newExchanges} rewritten=${rewritten} storeFiles=${after}`);
} catch (e) {
  failed = true;
  log('FAILED:', e.message);
  runLog('failed', { error: String(e.message).slice(0, 300) });
  process.exitCode = 1;
} finally {
  // No stamp after a failure: a stamp says "this size was captured", and it was not. Without this
  // a failed ingest followed by no further growth was a permanent skip after one `failed` line.
  //
  // 🟥 AND NO STAMP AFTER A WINDOWED RUN, for exactly the same reason (S-3, 2026-09-05).
  // MEMORY_INGEST_SINCE_MINUTES tells the extractor to consider a SLICE of the transcript, not the
  // file. `sizeAtStart` is then the size of a file this run did not read, so stamping it makes the
  // claim "this size was captured" about bytes nobody looked at — and the next ordinary run reads
  // that stamp, sees the transcript unchanged, and skips. MEASURED: `capture({sinceMinutes:0.001})`
  // against a 6-exchange transcript wrote 0 files, stamped 32,880 bytes, and the next full
  // auto-ingest captured 0 where the control (same transcript, no windowed call first) captured 6.
  // On the author's machine the caller was `npm test` and the transcript was the live 6.8 MB one.
  //
  // A windowed run is therefore a READ, not a capture checkpoint: it leaves the stamp exactly as it
  // found it, so the debounce still reflects the last run that considered the whole file. The only
  // cost is a redundant full pass later, which is the direction this file already errs in.
  if (!failed && WINDOWED) {
    log('windowed run (--since-minutes): the debounce stamp is left untouched — a slice cannot ' +
        'claim the whole transcript was captured');
  }
  if (!failed && !WINDOWED) {
    try {
      stamps[txKey] = { at: Date.now(), size: sizeAtStart, ...(deferredInFlight ? { deferred: true } : {}) };
      writeFileSync(stampFile, JSON.stringify(stamps, null, 2) + '\n', 'utf8');
    } catch (_) { /* a missing stamp only costs a redundant run */ }
  }
  // The index-pending window is closed only by a run that actually got through it.
  if (!failed) { try { unlinkSync(pendingPath); } catch (_) { /* already gone */ } }
  // Release only OUR lock. An unconditional unlink removed whichever run held it.
  try { if (parseInt(readFileSync(lock, 'utf8').trim(), 10) === process.pid) unlinkSync(lock); } catch (_) { /* best effort */ }
}
