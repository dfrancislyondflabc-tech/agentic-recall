// lib/scheduler.js — A LOADED SERVER KEEPS TIME.
//
// THE PROBLEM. Capture had two triggers and both of them are somebody else's job. The Stop hook
// fires when a turn ends, so a chat left open all afternoon is captured never. The 5-minute walker
// fires from a macOS LaunchAgent — a plist, installed by hand, that DOES NOT EXIST ON WINDOWS.
// Put plainly: on Windows the only capture that ever ran was the hook, and a hook only reaches the
// session that just stopped. Daniel's ask, verbatim: "can we make it so that even having memory
// mcp loaded makes time run."
//
// So the thing that is already loaded whenever memory matters — this server — keeps the time. It is
// started when the connector is switched on, it is running for as long as the connector is on, and
// it is already the process whose heartbeat DECIDES whether capture is allowed to write at all
// (lib/heartbeat.js, scripts/auto-ingest.js). A timer here is on exactly when capture is permitted
// and off exactly when it is not, which is a property neither a LaunchAgent nor a hook can have.
//
// 🟥 THE SERVER IS A SCHEDULER, NOT A WRITER. It never indexes, never extracts, never opens the
// store. It SPAWNS the existing walker (scripts/timed-capture.mjs), which spawns the existing
// per-session writer (scripts/auto-ingest.js), which holds the lock, the debounce, the reconcile
// pass and the crash marker. One write path, unchanged. A second writer inside a long-lived
// process is how you get two builds racing over one index, and this project has already paid for
// that lesson once (auto-ingest.js's `wx` lock comment).
//
// WHY THAT SPAWN IS SAFE IN AN MCP SERVER. detached + stdio:'ignore' + unref() means the child is
// not a child in any way that matters: no pipes to drain, no exit to await, nothing keeping this
// process alive, and — windowsHide — no console window blinking on a Windows desktop every five
// minutes. The tick timer is unref()'d too, so the server still exits the moment Claude closes the
// transport. Every failure resolves to "no walk this tick": a scheduler that can crash its host is
// worse than no scheduler.
//
// FOUR SERVERS, ONE WALKER. Claude Desktop runs one of these processes, and Claude Code runs
// another PER CHAT — four were live on this machine last night, and the LaunchAgent makes five.
// Two things keep that from becoming five concurrent walks:
//   * the WALKER LOCK (below, and taken in scripts/timed-capture.mjs) — a second walker exits 0
//     saying so, the same wx+liveness pattern auto-ingest already uses;
//   * the WALKER STAMP — every walker records when it started, whoever launched it, so a server
//     whose neighbour (or the LaunchAgent) walked 40 seconds ago simply does not fire.
// Plus per-process JITTER, so N servers that all booted together do not all reach the same
// conclusion in the same millisecond and then all lose the same race.

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHidden } from './child.js';
import { renameWithRetry } from './fs-retry.js';
import { stateRoot } from './state-root.js';

// ---- TWO ROOTS, AND THEY ARE NOT THE SAME ROOT -----------------------------------------------
//
// CODE_ROOT is where the scripts are; DATA_ROOT is where the store is. They coincide on an
// ordinary install and diverge on this machine, where MEM-21 froze the capture CODE into
// dist/capture/ while the DATA stayed in the repo. Collapsing them (the obvious one-liner) would
// either make the released copy write into dist/, or make a MEMORY_ROOT-configured install look
// for its scripts in the data directory and find none.
const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_ROOT = stateRoot();   // see lib/state-root.js

export const DEFAULT_INTERVAL_SEC = 300;
export const DEFAULT_TICK_MS = 60_000;
/** A lock whose holder is not alive is not a lock; this is only the fallback for an unreadable pid. */
export const LOCK_STALE_SEC = 15 * 60;

// ---- THE AUDIT TICK'S OWN CLOCK (MEM-50) -----------------------------------------------------
// A second, much slower timer on the same scheduler. It does not capture anything; it asks whether
// what the stamps CLAIM was captured is actually in the store (lib/store-audit-tick.js).
export const DEFAULT_AUDIT_MIN = 60;            // MEMORY_STORE_AUDIT_MIN — 0 turns it off
export const DEFAULT_AUDIT_DELAY_MIN = 5;       // MEMORY_STORE_AUDIT_DELAY_MIN — not during the boot storm
export const DEFAULT_AUDIT_GRACE_MIN = 15;      // MEMORY_STORE_AUDIT_GRACE_MIN — younger than this, `missing` is normal
export const DEFAULT_AUDIT_MAX_SESSIONS = 20;   // MEMORY_STORE_AUDIT_MAX_SESSIONS — newest first

/**
 * The store, resolved WITHOUT importing lib/config.js.
 *
 * Deliberate duplication of ownStoreDir(): this module is imported by scripts/timed-capture.mjs,
 * whose config import is already wrapped in a try/catch precisely because a library that cannot
 * load must not silently stop capture. The lock is the one thing that must survive that failure —
 * losing it means two walkers, and two walkers is the race the lock exists to prevent. Three lines
 * of duplication buy that. (a79) asserts the two agree, so the drift is a test failure.
 */
export function storeDir() {
  const v = process.env.MEMORY_OWN_STORE;
  if (v === '0' || v === 'false') return null;
  return v ? resolve(v) : join(DATA_ROOT, 'store');
}

/** `store/.timed-capture-last.json` — when a walk last STARTED, and who started it. */
export function walkerStampPath() {
  if (process.env.MEMORY_TIMED_CAPTURE_STAMP) return process.env.MEMORY_TIMED_CAPTURE_STAMP;
  const s = storeDir();
  return s ? join(s, '.timed-capture-last.json') : null;
}

/** `store/.timed-capture.lock` — at most one walker on this machine at a time. */
export function walkerLockPath() {
  if (process.env.MEMORY_TIMED_CAPTURE_LOCK) return process.env.MEMORY_TIMED_CAPTURE_LOCK;
  const s = storeDir();
  return s ? join(s, '.timed-capture.lock') : null;
}

/** The run log both writers already append to, so a walk and its ingests read as one story. */
export function runLogPath() {
  if (process.env.MEMORY_INGEST_LOG) return process.env.MEMORY_INGEST_LOG;
  const s = storeDir();
  return s ? join(s, '.ingest-runs.jsonl') : null;
}

/** `store/.store-audit-last.json` — when an audit last STARTED, and who started it. */
export function auditStampPath() {
  if (process.env.MEMORY_STORE_AUDIT_STAMP) return process.env.MEMORY_STORE_AUDIT_STAMP;
  const s = storeDir();
  return s ? join(s, '.store-audit-last.json') : null;
}

/**
 * `store/.store-audit.lock` — at most one audit on this machine at a time.
 *
 * 🟥 NOT THE WALKER LOCK. Two locks, and the distinction is the whole safety argument: this one
 * says "an audit is running", the walker's says "a writer is in the store". The audit holds THIS
 * one for its whole run (so four servers do not each spawn a 27-second child), and takes the
 * WALKER lock only for the seconds it is actually repairing. One lock for both would mean an
 * hourly read blocking the five-minute capture, which is a worse bug than the one being detected.
 * Ordering is fixed — audit lock, then walker lock, never the reverse — so the pair cannot deadlock.
 */
export function auditLockPath() {
  if (process.env.MEMORY_STORE_AUDIT_LOCK) return process.env.MEMORY_STORE_AUDIT_LOCK;
  const s = storeDir();
  return s ? join(s, '.store-audit.lock') : null;
}

/**
 * WHICH COPY OF THE WALKER RUNS.
 *
 * MEM-21: on this machine an uncommitted edit to the extractor went live on the LaunchAgent's next
 * tick and deleted a real memory. The answer was dist/capture/ — the capture code frozen at a
 * committed sha — and the rule that the hooks and the timer run THAT, never the working tree. This
 * scheduler is a third trigger for the same code and obeys the same rule: released copy if one
 * exists, otherwise the tree itself, which is what a packaged install (every Windows install) is.
 *
 * MEMORY_CAPTURE_SCRIPT overrides both. It is configuration, not a test seam — a packaged install
 * may put the walker anywhere — and the public scheduler e2e sets it so that it exercises ITS OWN
 * tree rather than whatever sha happens to be frozen in dist/ on the developer's laptop.
 */
export function walkerScript(codeRoot = CODE_ROOT) {
  if (process.env.MEMORY_CAPTURE_SCRIPT) return process.env.MEMORY_CAPTURE_SCRIPT;
  const released = join(codeRoot, 'dist', 'capture', 'scripts', 'timed-capture.mjs');
  if (existsSync(released)) return released;
  return join(codeRoot, 'scripts', 'timed-capture.mjs');
}

/**
 * WHICH COPY OF THE AUDIT TICK RUNS — and, unlike the walker, it is ALWAYS THIS TREE'S.
 *
 * dist/capture/ exists to freeze the code that WRITES the store at a committed sha (MEM-21). The
 * audit tick does not write memories: it compares them, and it spawns the frozen extractor
 * (lib/store-audit-tick.js extractorScript()) for the two occasions when something has to be
 * written. Pinning the detector to a frozen sha would mean a released copy predating this feature
 * silently answers "no such file" forever — a detector that cannot be shipped is not one.
 */
export function auditTickScript(codeRoot = CODE_ROOT) {
  if (process.env.MEMORY_STORE_AUDIT_SCRIPT) return process.env.MEMORY_STORE_AUDIT_SCRIPT;
  return join(codeRoot, 'scripts', 'store-audit-tick.mjs');
}

/** How often an audit is wanted, in seconds. `MEMORY_STORE_AUDIT_MIN=0` returns 0, which is OFF. */
export function auditIntervalSec() {
  const raw = process.env.MEMORY_STORE_AUDIT_MIN;
  const min = raw === undefined || raw === '' ? DEFAULT_AUDIT_MIN : Number(raw);
  return Number.isFinite(min) && min > 0 ? min * 60 : 0;
}

/** OFF is a supported answer. `MEMORY_SCHEDULER=0` and the server keeps time for nobody. */
export function schedulerEnabled() {
  const v = String(process.env.MEMORY_SCHEDULER ?? '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

// ---- liveness, the same test the rest of the project uses ------------------------------------
// process.kill(pid, 0) sends no signal; it asks whether the pid can be signalled. It works on
// win32 — libuv maps it to OpenProcess — and EPERM means "alive, and not yours", which is still
// alive. Anything else means gone.
export const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Is a walker running right now? Reads the lock; a dead or unreadable holder is NOT a lock. */
export function walkerLockAlive(lockPath = walkerLockPath()) {
  if (!lockPath || !existsSync(lockPath)) return false;
  let holder = NaN;
  try { holder = parseInt(String(readFileSync(lockPath, 'utf8')).trim(), 10); } catch { return false; }
  if (processAlive(holder)) return true;
  // An unreadable pid falls back to age, so a lock file that is somehow neither parseable nor
  // stale still blocks for a bounded time instead of forever or not at all.
  if (Number.isInteger(holder)) return false;
  try { return (Date.now() - statSync(lockPath).mtimeMs) / 1000 < LOCK_STALE_SEC; } catch { return false; }
}

/**
 * 🟥 MEM-62 — WHERE THE RUN LOG GOES WHEN THE LOCK CANNOT BE CREATED AT ALL.
 *
 * Beside the lock, because that is where the store's run log lives, and DERIVED rather than always
 * runLogPath(): a caller that passed a sandbox lock path (a test, a second install) must not be
 * able to make this write a `failed` row into the REAL installation's run log and stamp its
 * captureHealth unhealthy.
 */
function lockFailLogPath(lockPath) {
  if (process.env.MEMORY_INGEST_LOG) return process.env.MEMORY_INGEST_LOG;
  try { return join(dirname(lockPath), '.ingest-runs.jsonl'); } catch { return runLogPath(); }
}

/**
 * 🟥 MEM-62 — A LOCK THAT CANNOT BE CREATED IS NOT A LOCK THAT IS HELD, and for one campaign run
 * the product said it was.
 *
 * Measured (campaign A run 2, 2026-09-05): the store was held at mode 0500 for three minutes, timed
 * to contain a walk. The brief's requirement was that capture log `failed` loudly. What the run log
 * got was `{"outcome":"skipped","why":"walker lock held","heldBy":11469}` — twice — for a pid that
 * had been dead for six minutes. No `failed` row anywhere; nothing in the log, in captureHealth or
 * on stderr mentioned permissions. A human diagnosing "why did capture stop" is sent looking for a
 * walker that does not exist. Nothing was lost (the server answered throughout, recovery took 42.5 s
 * after chmod 755) — this is a diagnosability defect, so the fix is an errno, not a retry.
 *
 * EEXIST is the ONLY errno that means "held": it is the `wx` create losing to a file that is already
 * there. Every other one — EACCES/EROFS/EPERM on a read-only or foreign-owned store, ENOSPC on a
 * full disk, ENOENT on a directory that could not be created — is the store refusing the write, and
 * is now reported as such: a `failed` row carrying `<errno>: <path>`, and stderr when the run log is
 * unwritable too, which in the read-only case it usually is because it lives in the same directory.
 */
function lockUnwritable(lockPath, e) {
  const code = (e && e.code) || 'EUNKNOWN';
  const why = `${code}: ${lockPath}`;
  const logged = appendWalkerRun({ outcome: 'failed', why, error: code }, lockFailLogPath(lockPath));
  if (!logged) {
    // The last channel there is. A store this process cannot write is exactly the case where the
    // run log cannot be written either, so this is the common path and not the fallback.
    try { process.stderr.write(`[scheduler] the walker lock cannot be created — ${why}\n`); } catch { /* nothing left to try */ }
  }
  return { ok: false, heldBy: null, path: lockPath, error: code, why };
}

/**
 * Take the walker lock. `wx` makes CREATION the test — an existsSync-then-write is a check-then-act
 * gap, and this project has already measured two writers both winning it (auto-ingest.js).
 *
 * @returns {{ok:true, path:string} | {ok:false, heldBy:number|null, path:string|null, error?:string, why?:string}}
 *          `error` is set ONLY when the store refused the write; a fair loss for the lock has none.
 */
export function acquireWalkerLock(lockPath = walkerLockPath()) {
  if (!lockPath) return { ok: false, heldBy: null, path: null };
  const write = () => { writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return true; };
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* exists, or unwritable — the write below says which */ }
  try { write(); return { ok: true, path: lockPath }; }
  catch (e) { if (e.code !== 'EEXIST') return lockUnwritable(lockPath, e); }

  let holder = NaN;
  try { holder = parseInt(String(readFileSync(lockPath, 'utf8')).trim(), 10); } catch { /* unreadable = dead */ }
  if (processAlive(holder)) return { ok: false, heldBy: holder, path: lockPath };
  // 🟥 REMEMBER WHY THE UNLINK FAILED. This is the branch campaign A actually hit — the minute-48
  // kill had left a stale lock behind, so the read-only store took THIS path and not the one above.
  // ENOENT means somebody else cleared it first, which is fine and expected. Any other errno means
  // the file is still there because we are not allowed to remove it, and the EEXIST the re-create
  // then throws is OUR OWN undeleted lock rather than a neighbour's fresh one. Discarding it is how
  // a mode-0500 store came to be reported, twice, as `walker lock held by pid 11469` — a pid that
  // had been dead for six minutes.
  let unlinkErr = null;
  try { unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') unlinkErr = e; }
  try { write(); return { ok: true, path: lockPath, tookFrom: Number.isInteger(holder) ? holder : null }; }
  catch (e) {
    if (e.code === 'EEXIST' && unlinkErr) return lockUnwritable(lockPath, unlinkErr);
    // A clean unlink followed by EEXIST IS a fair loss: the file came back between our unlink and
    // our create, which means a live neighbour won the race.
    if (e.code === 'EEXIST') return { ok: false, heldBy: holder || null, path: lockPath };
    return lockUnwritable(lockPath, e);
  }
}

/** Release the lock — but ONLY if it is still ours. An unconditional unlink frees someone else's. */
export function releaseWalkerLock(lockPath = walkerLockPath()) {
  if (!lockPath) return false;
  try {
    if (parseInt(String(readFileSync(lockPath, 'utf8')).trim(), 10) !== process.pid) return false;
    unlinkSync(lockPath);
    return true;
  } catch { return false; }
}

/** `{at, pid, source}` of the last walk that STARTED, or null. */
export function readWalkerStamp(stampPath = walkerStampPath()) {
  if (!stampPath || !existsSync(stampPath)) return null;
  try {
    const o = JSON.parse(readFileSync(stampPath, 'utf8'));
    return o && typeof o.at === 'string' ? o : null;
  } catch { return null; }
}

/**
 * A JSON sidecar written so a reader can never see a half-file (MEM-57).
 *
 * 🟥 WHY THIS EXISTS. `writeFileSync(path, …)` opens with O_TRUNC: the file is ZERO BYTES for the
 * instant between the truncate and the write, and every reader in that instant sees an empty file.
 * Campaign C's SIGKILL matrix caught it once in five reps (`.timed-capture-last.json` left at 0
 * bytes), and a writer racing a reader makes it routine — measured on this branch before the fix,
 * 194 of 2,422 reads (8.0 %) over four seconds saw an empty stamp; after it, 0 of 2,414.
 *
 * It fails SAFE either way — readWalkerStamp() JSON.parses inside a try and a null stamp reads as
 * "no walk has ever been recorded" ⇒ spawn, and the lock makes the redundant walk harmless — so
 * this is the invariant, not a live bug: "every state file in this project is written atomically"
 * was FALSE here while lib/safe-write.js, lib/vector-cache.js, lib/index-store.js and
 * scripts/ingest-transcript.js all did temp + rename. The next writer added under that assumption
 * is where it would have bitten.
 *
 * renameWithRetry, not renameSync, for the Windows reason in lib/fs-retry.js: MoveFileEx refuses
 * while a scanner holds either path, and a stamp lost to EPERM is a redundant walk we can avoid.
 * Best effort throughout — the callers below already treat a failed stamp as survivable.
 */
function writeJsonAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameWithRetry(tmp, path);
    return true;
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * Record that a walk is starting. Written at START, not at finish: the question the scheduler asks
 * is "has anyone STARTED one recently", and a stamp written at the end would let every server on
 * the machine fire during the minute a slow walk was still running.
 */
export function writeWalkerStamp({ source = 'unknown', stampPath = walkerStampPath(), now = Date.now() } = {}) {
  if (!stampPath) return null;
  const row = { at: new Date(now).toISOString(), pid: process.pid, source };
  try { mkdirSync(dirname(stampPath), { recursive: true }); } catch { /* the write below reports it */ }
  // Atomic (MEM-57): a reader must see the old stamp or the new one, never the zero-byte window.
  writeJsonAtomic(stampPath, JSON.stringify(row) + '\n');   // a stamp that cannot be written costs a redundant walk, never a lost one
  return row;
}

const RUN_LOG_MAX = Number(process.env.MEMORY_INGEST_LOG_MAX_BYTES ?? 2 * 1024 * 1024);

/** One line in the log auto-ingest already writes, so a walk and its ingests interleave readably. */
export function appendWalkerRun(row, logPath = runLogPath()) {
  if (!logPath) return false;
  try {
    try { if (statSync(logPath).size > RUN_LOG_MAX) renameWithRetry(logPath, logPath + '.1'); } catch { /* first run, or a holder */ }
    try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* exists */ }
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), trigger: 'walker',
      pid: process.pid, ...row }) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/**
 * The audit's row in the SAME log, marked `trigger:'audit'`.
 *
 * One log, because the question a reader asks afterwards is "what happened to capture between 09:00
 * and 10:00", and an answer split across two files is one nobody assembles. The trigger field is
 * what keeps lib/ingest-health.js from reading an audit row as an ingest that never finished —
 * exactly the mistake MEM-38 #5 made with the walker's rows.
 */
export function appendAuditRun(row, logPath = runLogPath()) {
  if (!logPath) return false;
  try {
    try { if (statSync(logPath).size > RUN_LOG_MAX) renameWithRetry(logPath, logPath + '.1'); } catch { /* first run, or a holder */ }
    try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* exists */ }
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), trigger: 'audit',
      pid: process.pid, ...row }) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/** `{at, pid, source}` of the last audit that STARTED, or null. */
export function readAuditStamp(stampPath = auditStampPath()) {
  if (!stampPath || !existsSync(stampPath)) return null;
  try {
    const o = JSON.parse(readFileSync(stampPath, 'utf8'));
    return o && typeof o.at === 'string' ? o : null;
  } catch { return null; }
}

/** Written at START, for the same reason writeWalkerStamp() is: the question is "has anyone begun". */
export function writeAuditStamp({ source = 'unknown', stampPath = auditStampPath(), now = Date.now() } = {}) {
  if (!stampPath) return null;
  const row = { at: new Date(now).toISOString(), pid: process.pid, source };
  try { mkdirSync(dirname(stampPath), { recursive: true }); } catch { /* the write below reports it */ }
  // Same shape as writeWalkerStamp: MEM-50's stamp had the identical non-atomic write (MEM-57).
  writeJsonAtomic(stampPath, JSON.stringify(row) + '\n');   // a stamp that cannot be written costs a redundant audit, never a missed one
  return row;
}

// ---- THE DECISION, AS A PURE FUNCTION --------------------------------------------------------
//
// Separated from the timer on purpose. Everything interesting about a scheduler is the decision,
// and a decision buried in a setInterval callback can only be tested by waiting — which is how you
// end up with a five-minute test that is flaky anyway. This takes the world as arguments and
// returns a verdict with a reason; (a79) drives the whole truth table in microseconds.

/**
 * 🟥 MEM-60 — THE PERIOD MUST BE THE INTERVAL, AND FOR A YEAR IT WAS THE INTERVAL PLUS A TICK.
 *
 * Measured (campaign A, 2026-09-05): on shipped defaults the observed walk period was 360 s, not
 * the configured 300 s — 10 of 11 gaps in a 60-minute soak, 19 of 19 across two runs, and 60 s→120 s
 * at a 60 s interval in the control. Twenty of twenty-one jitter draws give exactly 360 s. The whole
 * 5-minute budget was spent before capture even began.
 *
 * TWO CAUSES, BOTH ARITHMETIC, NEITHER LOAD:
 *
 * (1) THE CLOCK BELONGED TO THE CHILD. `age` was measured against `.timed-capture-last.json`, which
 *     scripts/timed-capture.mjs writes INSIDE THE SPAWNED WALKER, tens of milliseconds after the
 *     tick that spawned it. With 300 an exact multiple of the 60 s tick, tick 5 lands a few ms SHORT
 *     of 300 s and is refused; tick 6 fires, at 360. The scheduler was racing its own child and
 *     losing by 30 ms. So the scheduler now decides against ITS OWN spawn time (`lastSpawnAt`, held
 *     in-process by startScheduler and set at the tick that spawned). The on-disk stamp stays: it is
 *     the CROSS-PROCESS signal — four servers and a LaunchAgent share it — and the fallback after a
 *     restart. The reference is the LATER of the two, so a neighbour's walk still suppresses ours.
 *
 * (2) A DUE POINT BETWEEN TWO TICKS COST A WHOLE TICK. A decision made every 60 s can only fire on a
 *     60 s grid, so a due point at 300.001 s waits until 360. `tickMs` is now an input and a due
 *     point that falls inside the COMING tick counts as due now (half a tick of slack, never more
 *     than half the interval). That is what makes the period `interval ± tick/2` instead of
 *     `interval + tick`, and it is what stops jitter — 0–20 s, added to the due point — from costing
 *     a full extra tick in 20 draws out of 21.
 *
 * Firing a shade early is the safe direction: the LOCK is the real mutual exclusion, so the worst
 * case is one walker that exits saying somebody else is already walking.
 *
 * @param {object} o
 * @param {number}  [o.now]                  ms
 * @param {string|number|null} [o.lastWalkerStartedAt]  the on-disk stamp; ISO string or ms; null = never
 * @param {string|number|null} [o.lastSpawnAt]  THIS process's own last spawn; ms; null = not since boot
 * @param {boolean} [o.walkerLockAlive]      a walker is running right now
 * @param {number}  [o.intervalSec]          how often a walk is wanted
 * @param {number}  [o.jitterSec]            this process's fixed offset
 * @param {number}  [o.tickMs]               how often this decision is made; 0 = no grid, no slack
 * @param {boolean} [o.enabled]              the kill switch, already read
 * @returns {{spawn:boolean, why:string, ageSec:number|null, dueSec:number, slackSec:number}}
 */
export function shouldSpawn({ now = Date.now(), lastWalkerStartedAt = null, lastSpawnAt = null,
  walkerLockAlive = false, intervalSec = DEFAULT_INTERVAL_SEC, jitterSec = 0,
  tickMs = DEFAULT_TICK_MS, enabled = true } = {}) {
  const dueSec = Number(intervalSec) + Number(jitterSec || 0);
  // Half a tick of slack, capped at half the interval so a tick COARSER than the interval (a test
  // that leaves tickMs at 60 s and sets the interval to 2 s) cannot make every tick due at age 0.
  const tickSec = Math.max(0, Number(tickMs) || 0) / 1000;
  const slackSec = Math.min(tickSec, Math.max(0, Number(intervalSec) || 0)) / 2;
  if (!enabled) return { spawn: false, why: 'MEMORY_SCHEDULER=0', ageSec: null, dueSec, slackSec };
  // A live walker wins over every clock. This is the check that makes N servers safe.
  if (walkerLockAlive) return { spawn: false, why: 'a walker is already running', ageSec: null, dueSec, slackSec };
  if (!(Number(intervalSec) > 0)) return { spawn: false, why: `interval ${intervalSec}s disables the timer`, ageSec: null, dueSec, slackSec };

  // THE LATER OF THE TWO, and the slack above is what makes that safe. Our own spawn time and the
  // stamp our own child then writes are the same event ~30 ms apart, so taking the later of them
  // costs 30 ms of a 30 s allowance; a DIFFERENT process's walk is a genuinely later event and
  // suppressing on it is the point. Requiring both to be due is identical to comparing against the
  // later timestamp, which is why this is one subtraction and not two branches.
  const ms = (v) => { const n = typeof v === 'string' ? Date.parse(v) : Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const stampAt = ms(lastWalkerStartedAt);
  const ownAt = ms(lastSpawnAt);
  const at = stampAt === null ? ownAt : (ownAt === null ? stampAt : Math.max(stampAt, ownAt));
  if (at === null) return { spawn: true, why: 'no walk has ever been recorded', ageSec: null, dueSec, slackSec };

  const ageSec = (now - at) / 1000;
  // A stamp from the future is a clock that moved, not a walk that is about to happen. Treat it as
  // due: the LOCK is the real mutual exclusion, so the cost of being wrong here is one walker that
  // exits immediately, and the cost of the other choice is capture stopping until the clock catches
  // up — which on a laptop whose timezone was just fixed could be hours.
  if (ageSec < 0) return { spawn: true, why: 'the last walk is stamped in the future (clock moved)', ageSec, dueSec, slackSec };

  // `ageSec + slackSec >= dueSec` — "the due point is reached before the next tick", not "the due
  // point has passed". The `why` string keeps its shape (`last walk Ns ago, due at Ds`) because it
  // is what the server log has always printed and what a reader greps for.
  return ageSec + slackSec >= dueSec
    ? { spawn: true, why: `last walk ${Math.round(ageSec)}s ago, due at ${dueSec}s`, ageSec, dueSec, slackSec }
    : { spawn: false, why: `last walk ${Math.round(ageSec)}s ago, due at ${dueSec}s`, ageSec, dueSec, slackSec };
}

/**
 * THE AUDIT DECISION, on the same terms as shouldSpawn() and for the same reason.
 *
 * Deliberately NOT given the walker lock as an input. A walk in progress is a reason for the TICK
 * to skip (lib/store-audit-tick.js checks it, and re-checks it before repairing, because the
 * useful moment to look is when the child actually starts, not when the parent decided). Putting
 * it here would suppress the audit for the whole hour on the strength of a lock held for the two
 * seconds the decision happened to be made in.
 *
 * @param {object} o
 * @param {number}  [o.now]              ms
 * @param {string|number|null} [o.lastAuditAt]   ISO string or ms; null = never
 * @param {number}  [o.intervalSec]      auditIntervalSec(); 0 = off
 * @param {number}  [o.bootedAt]         ms; the first audit waits delaySec after this
 * @param {number}  [o.delaySec]         MEMORY_STORE_AUDIT_DELAY_MIN, in seconds
 * @returns {{audit:boolean, why:string, ageSec:number|null, dueSec:number}}
 */
export function shouldAudit({ now = Date.now(), lastAuditAt = null, intervalSec = DEFAULT_AUDIT_MIN * 60,
  bootedAt = null, delaySec = DEFAULT_AUDIT_DELAY_MIN * 60 } = {}) {
  const dueSec = Number(intervalSec);
  if (!(dueSec > 0)) return { audit: false, why: 'MEMORY_STORE_AUDIT_MIN=0 (the audit is off)', ageSec: null, dueSec: 0 };

  // THE BOOT DELAY IS NOT COSMETIC. Claude starts every enabled server at launch and this child
  // spawns N extractors; landing that on top of the connector storm is how a detector becomes the
  // thing being complained about. It is a delay on the FIRST audit only — the stamp takes over
  // afterwards, and a machine that is rebooted hourly still audits, one delay later each time.
  if (bootedAt !== null && Number.isFinite(Number(bootedAt))) {
    const upSec = (now - Number(bootedAt)) / 1000;
    if (upSec < Number(delaySec || 0)) {
      return { audit: false, why: `booted ${Math.round(upSec)}s ago, first audit at ${Math.round(Number(delaySec))}s`, ageSec: null, dueSec };
    }
  }

  const at = typeof lastAuditAt === 'string' ? Date.parse(lastAuditAt) : Number(lastAuditAt);
  if (!Number.isFinite(at) || at <= 0) return { audit: true, why: 'no audit has ever been recorded', ageSec: null, dueSec };

  const ageSec = (now - at) / 1000;
  // Same reading as shouldSpawn(): a stamp from the future is a clock that moved. Treat it as due —
  // the LOCK is the real mutual exclusion, and the cost of being wrong is one child that exits.
  if (ageSec < 0) return { audit: true, why: 'the last audit is stamped in the future (clock moved)', ageSec, dueSec };

  return ageSec >= dueSec
    ? { audit: true, why: `last audit ${Math.round(ageSec)}s ago, due at ${dueSec}s`, ageSec, dueSec }
    : { audit: false, why: `last audit ${Math.round(ageSec)}s ago, due at ${dueSec}s`, ageSec, dueSec };
}

/**
 * THE SECOND LOOK, taken after the decision and immediately before the spawn.
 *
 * 🟥 WHAT THIS IS FOR (MEM-83, the churn half). Every connected Claude client gets its OWN server
 * process, each with its own scheduler; the Windows tester was running five. `shouldSpawn()` reads
 * the on-disk stamp and suppresses a neighbour that walked recently, which handles the ordinary
 * staggered case — but the servers are all started by the same client launch, so their tick GRIDS
 * are phase-aligned to within the time it takes to load an index, and the jitter only moves the
 * DUE POINT, never the phase. Five schedulers that reach the due point in the same instant all
 * read the same stale stamp, all spawn, and four of them lose the lock a moment later. The lock
 * makes that SAFE; it does not make it free — five process spawns, five index loads' worth of
 * page cache, and on Windows five console windows.
 *
 * A stamp is written by the walker at its START, so re-reading it here catches every neighbour
 * that got as far as starting between the decision and this line. It cannot catch a neighbour
 * whose spawn is still in flight — nothing short of taking the lock in the parent could, and that
 * would mean this process holding a lock for a child's whole run. So: a cheap narrowing, honest
 * about its window, with the lock still the real mutual exclusion.
 *
 * ONLY A STAMP THAT MOVED COUNTS. `decidedWithAt` is the value `shouldSpawn()` already judged and
 * found old enough; skipping on it again would suppress every walk for ever the first time the
 * interval was set below twice the tick. The skip needs a genuinely NEW walk to point at.
 *
 * @param {object} o
 * @param {number} [o.now]
 * @param {string|number|null} [o.decidedWithAt]  the stamp the decision was made against
 * @param {string|number|null} [o.freshAt]        the stamp as it reads NOW
 * @param {number} [o.intervalSec]                the window is half of this
 * @param {string} [o.label]                      'walked' | 'audited', for the log line
 * @returns {{skip:boolean, why:string, ageSec:number|null, windowSec:number}}
 */
export function shouldSkipRecentWalk({ now = Date.now(), decidedWithAt = null, freshAt = null,
  intervalSec = DEFAULT_INTERVAL_SEC, label = 'walked' } = {}) {
  const ms = (v) => { const n = typeof v === 'string' ? Date.parse(v) : Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const windowSec = Math.max(0, Number(intervalSec) || 0) / 2;
  const fresh = ms(freshAt);
  if (fresh === null) return { skip: false, why: 'no walk is recorded on disk', ageSec: null, windowSec };
  const seen = ms(decidedWithAt);
  if (seen !== null && fresh <= seen) {
    return { skip: false, why: 'the stamp has not moved since the decision', ageSec: (now - fresh) / 1000, windowSec };
  }
  const ageSec = (now - fresh) / 1000;
  // A stamp from the future is a clock that moved, not a walk that just happened — the same
  // reading shouldSpawn() takes, and for the same reason: never stop capture over a clock.
  if (ageSec < 0) return { skip: false, why: 'the new stamp is in the future (clock moved)', ageSec, windowSec };
  return ageSec <= windowSec
    ? { skip: true, why: `another server ${label} ${ageSec.toFixed(1)}s ago`, ageSec, windowSec }
    : { skip: false, why: `the newer stamp is ${Math.round(ageSec)}s old, past the ${windowSec}s window`, ageSec, windowSec };
}

/**
 * Spawn one audit tick. Same detached/unref/windowsHide contract as spawnWalker, same reasons.
 *
 * @returns {{spawned:boolean, script?:string, pid?:number, error?:string}}
 */
export function spawnAuditTick({ script = auditTickScript(), dataRoot = DATA_ROOT, source = 'server' } = {}) {
  try {
    const child = spawnHidden(process.execPath, [script], {
      cwd: dataRoot,
      env: { ...process.env, MEMORY_ROOT: dataRoot, MEMORY_TIMER_SOURCE: source },
      detached: true, stdio: 'ignore'
    });
    child.unref();
    return { spawned: true, script, pid: child.pid };
  } catch (e) {
    return { spawned: false, script, error: String(e && e.message || e).slice(0, 200) };
  }
}

/**
 * A per-process offset so several servers do not fire in the same millisecond.
 *
 * Scaled to the interval rather than fixed at 0–20 s: a test that sets the interval to 2 s and
 * then waits up to 20 s for a jitter it did not ask about is a test that fails for the wrong
 * reason. 0–20 s at the 300 s default, 0–2 s at a 2 s interval.
 */
export function pickJitterSec(intervalSec = DEFAULT_INTERVAL_SEC, rnd = Math.random) {
  const env = Number(process.env.MEMORY_SCHEDULER_JITTER_SEC);
  if (Number.isFinite(env) && env >= 0) return env;
  const span = Math.min(20, Math.max(0, Number(intervalSec) || 0));
  return Math.floor(rnd() * (span + 1));
}

/**
 * Spawn one walk. Never awaited, never throws, never holds this process open.
 *
 * @returns {{spawned:boolean, script?:string, pid?:number, error?:string}}
 */
export function spawnWalker({ script = walkerScript(), dataRoot = DATA_ROOT, source = 'server' } = {}) {
  try {
    const child = spawnHidden(process.execPath, [script], {
      cwd: dataRoot,
      env: { ...process.env, MEMORY_ROOT: dataRoot, MEMORY_TIMER_SOURCE: source },
      detached: true,        // POSIX: its own process group, so a Ctrl-C in the host does not kill
                             // a half-finished capture. Windows: its own process.
      stdio: 'ignore'        // nothing to drain, so nothing can block on a full pipe
      // NO windowsHide HERE ANY MORE — spawnHidden (lib/child.js) sets it for every launch site in
      // the project. This one had it and the popups continued anyway, because the WALKER's own
      // children did not: MEM-83 is what "one place" is for.
    });
    child.unref();
    return { spawned: true, script, pid: child.pid };
  } catch (e) {
    return { spawned: false, script, error: String(e && e.message || e).slice(0, 200) };
  }
}

/**
 * Start keeping time. Returns a stop function.
 *
 * @param {object} [o]
 * @param {number} [o.tickMs]       how often the DECISION is made (cheap: one stat, one small read)
 * @param {number} [o.intervalSec]  how often a WALK is wanted
 * @param {(m:string)=>void} [o.log]
 */
export function startScheduler({ tickMs, intervalSec, log = () => {} } = {}) {
  const enabled = schedulerEnabled();
  const interval = Number(intervalSec ?? process.env.MEMORY_SCHEDULER_INTERVAL_SEC ?? DEFAULT_INTERVAL_SEC);
  const every = Number(tickMs ?? process.env.MEMORY_SCHEDULER_TICK_MS ?? DEFAULT_TICK_MS);
  if (!enabled) { log('capture scheduler OFF (MEMORY_SCHEDULER=0)'); return () => {}; }
  if (!(interval > 0) || !(every > 0)) { log(`capture scheduler OFF (interval=${interval}s tick=${every}ms)`); return () => {}; }

  const jitterSec = pickJitterSec(interval);
  log(`capture scheduler ON — a walk every ${interval}s (+${jitterSec}s jitter), checked every ${every}ms; walker=${walkerScript()}`);

  // THE AUDIT RIDES THE SAME TIMER, on its own clock. A second setInterval would be a second thing
  // to unref, a second thing to clear, and a second thing to forget in a test — for a decision that
  // costs one small file read.
  const auditSec = auditIntervalSec();
  const auditDelaySec = (() => {
    const raw = process.env.MEMORY_STORE_AUDIT_DELAY_MIN;
    const m = raw === undefined || raw === '' ? DEFAULT_AUDIT_DELAY_MIN : Number(raw);
    return Number.isFinite(m) && m >= 0 ? m * 60 : DEFAULT_AUDIT_DELAY_MIN * 60;
  })();
  const bootedAt = Date.now();
  if (auditSec > 0) log(`store audit ON — every ${auditSec}s, first one ${auditDelaySec}s after boot; tick=${auditTickScript()}`);
  else log('store audit OFF (MEMORY_STORE_AUDIT_MIN=0)');

  let lastSpawnLogged = null;
  // MEM-60: THE SCHEDULER'S OWN CLOCK. Set at the tick that spawned, so the period is measured from
  // the moment this process decided rather than from the moment its child got round to stamping.
  // Null until the first spawn OF THIS BOOT, which is what makes the on-disk stamp the fallback
  // after a restart and the coordination signal between processes at all other times.
  let lastSpawnAt = null;
  const auditTick = () => {
    try {
      // AT MOST ONE AUDIT, and the lock is what enforces it — not a flag in this process, because
      // four servers and a LaunchAgent are five processes and none of them can see the others'
      // flags. The child holds store/.store-audit.lock for its whole run; a neighbour that finds it
      // held simply does not fire.
      if (walkerLockAlive(auditLockPath())) return;
      const seen = readAuditStamp()?.at ?? null;
      const d = shouldAudit({ lastAuditAt: seen, intervalSec: auditSec,
        bootedAt, delaySec: auditDelaySec });
      if (!d.audit) return;
      // THE SECOND LOOK. One stat and one small read, in exchange for N-1 audit children on a
      // machine with N connected clients. Same shape as the walker below.
      const near = shouldSkipRecentWalk({ decidedWithAt: seen, freshAt: readAuditStamp()?.at ?? null,
        intervalSec: auditSec, label: 'audited' });
      if (near.skip) { log(`store audit skipped: ${near.why}`); return; }
      const r = spawnAuditTick({ source: 'server' });
      // Claim it, for the reason spelled out at the walker below: the neighbours cannot see this
      // process's intention, and the child takes a moment to write the stamp that would tell them.
      if (r.spawned) { try { writeAuditStamp({ source: 'server' }); } catch { /* a redundant audit, never a lost one */ } }
      log(r.spawned ? `store audit spawned (pid ${r.pid}) — ${d.why}` : `store audit FAILED to spawn: ${r.error}`);
    } catch (e) {
      try { log(`store audit tick skipped: ${String(e && e.message || e).slice(0, 160)}`); } catch { /* nothing left to try */ }
    }
  };

  const tick = () => {
    try {
      // ONE `now` FOR THE WHOLE TICK, and it is the value recorded as lastSpawnAt. A second
      // Date.now() inside spawnWalker would put the walker's own spawn cost back into the period.
      const at = Date.now();
      const stamp = readWalkerStamp();
      const d = shouldSpawn({ now: at, lastWalkerStartedAt: stamp?.at ?? null, lastSpawnAt,
        walkerLockAlive: walkerLockAlive(), intervalSec: interval, jitterSec, tickMs: every, enabled: true });
      if (!d.spawn) return;
      // THE SECOND LOOK, between the decision and the spawn. `stamp` above is what the decision
      // read; this is what the disk says now, and a neighbour that started a walk in between is
      // the whole point (shouldSkipRecentWalk).
      const near = shouldSkipRecentWalk({ now: Date.now(), decidedWithAt: stamp?.at ?? null,
        freshAt: readWalkerStamp()?.at ?? null, intervalSec: interval });
      if (near.skip) { log(`capture walk skipped: ${near.why}`); return; }
      const r = spawnWalker({ source: 'server' });
      // Only on success: a spawn that threw has not walked, and pretending it did would cost a
      // whole interval of capture for a failure that may clear on the next tick.
      if (r.spawned) lastSpawnAt = at;
      // 🟥 CLAIM THE WALK IMMEDIATELY (MEM-83, the churn half). MEASURED, not assumed: with two
      // servers on one 4-second interval, 4 of 4 intervals spawned TWO walkers and one lost the
      // lock every time — and re-reading the stamp between the decision and the spawn changed
      // nothing, because the window it re-reads across is microseconds while the race is the
      // ~200-400 ms a walker child needs to boot node and write its own stamp. A neighbour ticking
      // 100 ms later reads the stamp BEFORE anyone has written it, and spawns.
      //
      // `lastSpawnAt` above is this process already treating its own spawn as a walk for the whole
      // interval. The stamp is how the OTHER four servers get to know that, 300 ms before the child
      // could tell them. So it is not a new claim, it is the existing one made visible — and the
      // child overwrites it with its own pid a moment later, so the on-disk row stays the walker's.
      //
      // Costs nothing on failure: a spawn that did not happen writes no stamp, and a child that
      // dies before stamping leaves a stamp for an interval this process was already skipping.
      if (r.spawned) { try { writeWalkerStamp({ source: 'server' }); } catch { /* a redundant walk, never a lost one */ } }
      // One line per spawn, on stderr, because an invisible background writer is the thing this
      // project keeps having to diagnose after the fact.
      const msg = r.spawned ? `capture walk spawned (pid ${r.pid}) — ${d.why}` : `capture walk FAILED to spawn: ${r.error}`;
      if (msg !== lastSpawnLogged || r.spawned) { log(msg); lastSpawnLogged = msg; }
    } catch (e) {
      // A scheduler that can take its host down is worse than no scheduler.
      try { log(`capture scheduler tick skipped: ${String(e && e.message || e).slice(0, 160)}`); } catch { /* nothing left to try */ }
    }
    auditTick();
  };

  // FIRST TICK ON A SHORT DELAY, NOT AT BOOT. Claude starts every enabled server at launch; firing
  // a walk in that same instant puts an extractor and an index build on top of the connector storm.
  // One tick's grace is enough, and the walker's own stamp means a late first walk is never a
  // missed one.
  const first = setTimeout(tick, Math.min(every, 10_000));
  const t = setInterval(tick, every);
  if (typeof first.unref === 'function') first.unref();
  if (typeof t.unref === 'function') t.unref();
  return () => { clearTimeout(first); clearInterval(t); };
}
