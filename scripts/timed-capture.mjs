#!/usr/bin/env node
// scripts/timed-capture.mjs — capture without waiting for a turn to end.
//
//   node scripts/timed-capture.mjs [--window-min N] [--dry]
//
// WHY THIS EXISTS. Capture fires on the Stop hook, so its unit is a TURN — the whole run of work
// between two user messages. An exchange is written only once its turn ends, so capture lag equals
// turn length. Measured on this session: 1, 1, 1, 2, 10, 37, 41 and 57 minutes.
//
// 🟥 A CORRECTION — this file previously carried the wrong reason, twice over.
// It first said "ten exchanges written in the same second, then a 283-minute gap", read as
// accumulation during one long turn. I later told Daniel it was ten turns whose hook never fired.
// BOTH are wrong. What the store shows (store/x-b58a69af-*.md, file mtime vs frontmatter `ts`):
//   - the burst was 52 exchanges, not ten, and their ask-times span FIVE DAYS (2026-08-28 →
//     2026-09-02). It was the first-ever ingest of a session that had run uncaptured for days.
//   - the 283-minute "gap" was 20:34 → 01:24 between two of Daniel's messages. No user turn means
//     no exchange. Nothing was missed, because there was nothing to capture.
// The hook is not failing: the run log holds 27 hook runs — 3 captured, 24 honest "no new
// exchanges".
//
// THE REAL GAP, measured across every session active in the last 72 hours: 4 of 31 had never been
// captured (all four scheduled tasks — see the guard in auto-ingest.js), and several show a last
// capture days older than their transcript, having been resumed since. A per-turn hook cannot reach
// a session that is resumed and closed without it firing, because it only ever runs for the session
// that just stopped. Walking every recently-touched transcript is what does.
//
// Sized honestly, against a control: a session captured live start-to-finish captures 59 of 77
// prose user turns; the "7 days behind" session captures 45 of 59 — the SAME 1.3x ratio. So the
// shortfall is single digits per session, not the ~1,559 exchanges I first computed by counting raw
// `type:"user"` entries (tool results carry that type too). Real, worth closing, NOT an emergency,
// and explicitly not grounds for a backfill pass.
//
// So: run on a timer as well, and let auto-ingest do exactly what it already does — with `--timed`,
// which defers the in-flight exchange. See test/timed-capture-preregistration.md.
//
// 🟥 EVERY ACTIVE SESSION, NOT THE NEWEST ONE. auto-ingest resolves a transcript from an argument
// or a session id and otherwise falls back to "most recent". On a machine running two conversations
// at once, that captures one and silently starves the other — and two-at-once is the normal case
// here. This walks every transcript touched inside the window instead.
//
// Safe to run at any time and at any frequency: auto-ingest keeps its own debounce (it skips when
// the transcript has not grown) and its own lock (it exits if another run holds it). This script
// adds no state of its own.

// 🟥 WHAT THIS PICKS, AND WHY IT CHANGED (2026-09-05).
//
// It used to pick RECENT transcripts: anything touched in the last 15 minutes. That is the wrong
// question. "Touched recently" and "holds work nobody wrote down" are different sets, and the whole
// point of the timer is the second one. A laptop that sleeps for two hours wakes with three
// transcripts all older than the window and every one of them uncaptured — the timer looked at
// them, said "nothing touched recently", and the work stayed lost until the next message in each
// chat. That is the sleep/wake loss.
//
// So it picks UNCAPTURED transcripts instead: no stamp in store/.last-ingest.json, or a live size
// larger than the size the extractor last read. SIZE, not mtime — deliberately the same signal
// auto-ingest's own debounce uses, so the two cannot disagree about whether there is anything to do.
//
// Two bounds, because "everything ever" is not a work list:
//   MEMORY_CAPTURE_MAX_AGE_DAYS  (7)  a transcript untouched for a week is history, not a backlog
//   MEMORY_CAPTURE_MAX_SESSIONS  (8)  per run, newest first; the rest are PRINTED as deferred and
//                                     picked up by the next tick, so a first run on a machine with
//                                     a long backlog is a queue, not a thundering herd
//
// --window-min / MEMORY_CAPTURE_WINDOW_MIN still works, but it is now an ADDITIONAL filter and it
// is OFF unless asked for. As the selector it was the defect.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSyncHidden } from '../lib/child.js';   // 🟥 MEM-83: THE five-minute popup, ×N servers

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 🟥 MEMORY_TRANSCRIPT_DIR, which this file was the only reader NOT to honour (2026-09-05).
// scripts/auto-ingest.js:projectDirs() and lib/capture-status.js:transcriptDirs() both let the
// override win over discovery; the walker hard-wired homedir(), so the writer, the reader and the
// SELECTOR could each be looking at a different set of conversations. It also made the walk the one
// part of capture that could not be pointed at a fixture without moving a real home directory.
//
// homedir() is NOT process.env.HOME: on Windows it reads USERPROFILE (uv_os_homedir), which is why
// every sandbox in this project has to set both.
const PROJECTS = process.env.MEMORY_TRANSCRIPT_DIR || join(homedir(), '.claude', 'projects');
const PROJECTS_IS_LEAF = !!process.env.MEMORY_TRANSCRIPT_DIR;   // an override names ONE folder of transcripts

const argMin = process.argv.indexOf('--window-min');
const WINDOW_MIN = argMin !== -1 ? Number(process.argv[argMin + 1])
  : process.env.MEMORY_CAPTURE_WINDOW_MIN !== undefined ? Number(process.env.MEMORY_CAPTURE_WINDOW_MIN)
  : null;                                              // null = no window filter at all
const MAX_AGE_DAYS = Number(process.env.MEMORY_CAPTURE_MAX_AGE_DAYS ?? 7);
const MAX_SESSIONS = Number(process.env.MEMORY_CAPTURE_MAX_SESSIONS ?? 8);
const DRY = process.argv.includes('--dry');

// The store, resolved exactly the way auto-ingest resolves it. Guarded, because this script's job
// is to keep running unattended: a library that cannot load must not silently stop capture.
let STORE = null;
try { ({ ownStoreDir: STORE } = await import('../lib/config.js')); STORE = STORE(); }
catch { STORE = process.env.MEMORY_OWN_STORE || join(ROOT, 'store'); }
const STAMPS = STORE ? join(STORE, '.last-ingest.json') : null;

// ---- A SLOT SPENT ON A SESSION THE WRITER WILL REFUSE IS A SLOT LOST (MEM-78) -----------------
//
// The walk takes at most MEMORY_CAPTURE_MAX_SESSIONS (8) transcripts per tick. Four of the eleven
// it was queueing on this machine were `<scheduled-task …>` sessions that scripts/auto-ingest.js
// refuses at its second line — so every tick paid a node spawn each to be told no, and a machine
// with a real backlog had four of its eight slots gone before it started. The predicate is now
// shared (lib/capturable.js) with the writer and with lib/capture-status.js, which is what stops
// the three of them disagreeing about which sessions exist.
//
// Guarded like every other import in this file: a library that cannot load must not stop capture —
// unfiltered is worse than filtered, it is not worse than not running.
let excludedSessionReason = () => null;
try { ({ excludedSessionReason } = await import('../lib/capturable.js')); }
catch (e) { console.error(`[timed-capture] capturable predicate unavailable (${e?.message || e}); selecting everything`); }

// ---- ONE WALKER AT A TIME, AND A RECORD THAT ONE RAN -----------------------------------------
//
// 🟥 WHY THIS FILE NEEDED A LOCK OF ITS OWN (2026-09-05). It used to say, in this very header,
// "safe to run at any time and at any frequency ... this script adds no state of its own", and that
// was true while there was exactly ONE thing firing it: a LaunchAgent, every 300 seconds, alone.
// It stopped being true the moment the server started keeping time (lib/scheduler.js): Claude
// Desktop runs one server and Claude Code runs one PER CHAT — four were live on this machine last
// night — and the LaunchAgent makes five. Five walkers is not five times the capture; it is five
// processes each spawning up to eight ingests that then fight over auto-ingest's per-session lock,
// and the losers exit having done nothing while the CPU is spent anyway.
//
// The per-session lock downstream cannot solve it, because by the time it is reached the walk has
// already paid for the readdir over every project, the stat over every transcript, the run-log
// crash check and a node spawn per session. So the walk itself is the thing to exclude.
//
// TWO NEW FILES, both in the store beside every other piece of writer state:
//   .timed-capture.lock       wx-created, holds the pid, cleared on exit; a live holder means a
//                             second walker exits 0 saying so, which is a NORMAL outcome, not an
//                             error — with five potential launchers, "somebody already did it" is
//                             the common case.
//   .timed-capture-last.json  {at, pid, source} written at START, so the schedulers can answer
//                             "has anyone walked recently" WITHOUT starting a process to find out.
//                             `source` is who fired it: 'server', 'launchagent', or whatever
//                             MEMORY_TIMER_SOURCE says.
const SOURCE = process.env.MEMORY_TIMER_SOURCE || 'launchagent';
let sched = null;
try { sched = await import('../lib/scheduler.js'); }
catch (e) {
  // A library that cannot load must not stop capture — the same rule the config import above
  // follows. Unlocked is worse than locked; it is not worse than not running.
  console.error(`[timed-capture] walker lock unavailable (${e?.message || e}); proceeding without it`);
}

// --dry IS AN INSPECTION, and an inspection writes nothing. It must not take the lock (which would
// make a real walk starting in the same second skip for no reason) and must not stamp (which would
// tell every scheduler on the machine that a walk had happened when none had).
if (sched && !DRY) {
  const got = sched.acquireWalkerLock();
  // MEM-62: A LOCK THAT COULD NOT BE CREATED IS NOT A LOCK THAT IS HELD. `skipped: walker lock
  // held` exits 0 because somebody else already walked, which is the NORMAL outcome with five
  // possible launchers. A store this process cannot write is the opposite of normal and used to
  // reach a human as that same reassuring sentence, naming a pid that had been dead for six
  // minutes. acquireWalkerLock has already written the `failed` row (or stderr, if the run log is
  // in the same unwritable directory); this is the exit code and the sentence.
  if (!got.ok && got.error) {
    console.error(`[timed-capture] FAILED: the store cannot be written (${got.error}: ${got.path}); no walk ran`);
    process.exit(1);
  }
  if (!got.ok) {
    console.log(`[timed-capture] skipped: walker lock held${got.heldBy ? ` by pid ${got.heldBy}` : ''}`);
    sched.appendWalkerRun({ outcome: 'skipped', why: 'walker lock held', source: SOURCE,
      ...(Number.isInteger(got.heldBy) ? { heldBy: got.heldBy } : {}) });
    process.exit(0);
  }
  // SIGKILL runs no exit handler, so a hard-killed walker leaves the lock behind — which is
  // exactly what the pid-liveness check in acquireWalkerLock() is for.
  process.on('exit', () => { try { sched.releaseWalkerLock(); } catch (_) { /* best effort */ } });
  sched.writeWalkerStamp({ source: SOURCE });
  sched.appendWalkerRun({ outcome: 'started', source: SOURCE });
  // MEM-50: the hourly transcript-vs-store audit rides the same trigger as the walk, so a machine
  // whose only walker is the LaunchAgent (no server loaded) still gets it. The tick takes its own
  // lock; a double trigger costs an immediate exit and nothing else.
  try {
    if (!sched.walkerLockAlive(sched.auditLockPath()) &&
        sched.shouldAudit({ lastAuditAt: sched.readAuditStamp()?.at ?? null, intervalSec: sched.auditIntervalSec() }).audit) {
      sched.spawnAuditTick({ source: 'walker' });
    }
  } catch (_) { /* never fail a walk for a detector */ }
  console.log(`[timed-capture] walker started (source: ${SOURCE}, pid ${process.pid})`);
}

/** The terminal line. Paired with `started`, so a walk that was killed is visible as a gap. */
function walkerFinished(extra = {}) {
  if (!sched || DRY) return;
  try { sched.appendWalkerRun({ outcome: 'finished', source: SOURCE, ...extra }); } catch (_) { /* best effort */ }
}

function readStamps() {
  if (!STAMPS || !existsSync(STAMPS)) return {};
  try { return JSON.parse(readFileSync(STAMPS, 'utf8')) || {}; } catch { return {}; }
}

/** Filled by activeTranscripts(): sessions capture will never take, and why. One line per walk. */
const excluded = { count: 0, reasons: {} };

function activeTranscripts() {
  const out = [];
  const stamps = readStamps();
  const now = Date.now();
  // The override names a directory of transcripts; discovery names a directory OF project
  // directories. Same walk, one level apart.
  let dirs = [];
  if (PROJECTS_IS_LEAF) dirs = [PROJECTS];
  else {
    try { dirs = readdirSync(PROJECTS).map((d) => join(PROJECTS, d)); } catch { return out; }
  }
  for (const p of dirs) {
    let files = [];
    try { files = readdirSync(p); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(p, f);
      let st; try { st = statSync(full); } catch { continue; }
      const ageMin = (now - st.mtimeMs) / 60000;
      if (ageMin / 1440 > MAX_AGE_DAYS) continue;                      // older than the hard cap
      if (WINDOW_MIN !== null && ageMin > WINDOW_MIN) continue;        // optional extra filter
      const stamp = stamps[full];
      const capturedBytes = stamp && Number.isFinite(stamp.size) ? stamp.size : 0;
      // 🟥 A DEFERRED IN-FLIGHT EXCHANGE IS UNFINISHED BUSINESS, AND THE SIZE CANNOT SEE IT
      // (MEM-67). `stamp.size` says which bytes the extractor READ, not which exchanges it WROTE:
      // a timed run that deferred the still-being-written exchange stamps the whole file and leaves
      // its newest exchange in no store file at all. An abandoned turn then never grows again, so
      // this line skipped the session for ever — the walker stopped looking, and the hourly store
      // audit was the only thing left that could heal it (~14 min measured on the Windows PC, ~75
      // worst case). auto-ingest now records `deferred` on such a stamp; the session stays selected
      // until a run captures that exchange, which the quiet rule makes it do within one tick of the
      // transcript falling silent.
      if (stamp && st.size <= capturedBytes && !stamp.deferred) continue;   // nothing new since capture
      // LAST, so the 64 KB head read is paid only for a transcript this walk was about to select
      // (MEM-78). An excluded session is not a deferral and not a backlog: it will never be
      // captured, so it is not queued and not counted as one that is waiting.
      const why = excludedSessionReason(full);
      if (why) { excluded.count++; excluded.reasons[why] = (excluded.reasons[why] || 0) + 1; continue; }
      out.push({ path: full, ageMin, session: f.slice(0, 8),
        grownBytes: st.size - capturedBytes, everCaptured: !!stamp,
        deferredInFlight: !!(stamp && stamp.deferred) });
    }
  }
  // Freshest first: if something goes wrong partway, the most active conversation is already done.
  return out.sort((a, b) => a.ageMin - b.ageMin);
}

// ---- A CRASHED PREVIOUS RUN FORCES A RECONCILE PASS -------------------------------------------
// lib/ingest-health.js reads the signature a killed run leaves in the run log. When it fires, every
// child this tick spawns is told to reconcile rather than trust its own "did I write anything?"
// test — which is the exact test that reported a lost 90 minutes as "index untouched".
//
// 🟥 AND THE PASS ITSELF RUNS EITHER WAY (T-1, 2026-09-05). This flag used to be consumed in ONE
// place — `childEnv` inside the per-session spawn loop — and the `if (!active.length)` early return
// below runs first. So in the exact shape the crash signature exists to catch (the hook wrote a
// store file and died before indexing; the transcript itself is fully captured, so nothing is
// selected) the sentence "forcing a reconcile pass" was printed and the flag reached nothing.
// Reproduced: store 5 → 6, index 5 → 5, crash line printed, `RECONCILED? NO`, tick after tick.
// The instrument fired and the actuator did nothing.
//
// See reconcilePass() below: the store-vs-index comparison (lib/reconcile.js) now runs on EVERY
// tick, selected transcripts or none — the ordinary debounce keeps a quiet tick to one stat pass,
// and a crash signature bypasses that debounce. Only the per-session INGESTS depend on selection.
let forceReconcile = false;
try {
  const { lastRunCrashed } = await import('../lib/ingest-health.js');
  const crash = lastRunCrashed({});
  if (crash.crashed) {
    forceReconcile = true;
    console.log(`[timed-capture] crash-detected: run pid ${crash.pid} (${crash.session || 'unknown session'}) ` +
      `stopped at ${crash.at} with outcome '${crash.outcome}' and never finished; forcing a reconcile pass`);
  }
} catch (_) { /* a health check that cannot load must not stop capture */ }


// ---- THE RECALL CANARY (passive) --------------------------------------------------------------
// Two facts per tick, from one 4 KB index-header read and one stat pass over the store: which
// newly-written files have become visible to the index, and how long each took. No index parse,
// no model, no synthetic write into the corpus. See lib/recall-canary.js for what the visibility
// heuristic can and cannot prove.
//
// It runs on EVERY tick, including the quiet ones — a tick with no uncaptured transcript is
// exactly when a file that was written and never indexed goes unnoticed, which is the shape of the
// 04:52Z incident. Wrapped whole: the canary must never be the reason capture did not run.
const LAG_ALARM_SEC = Number(process.env.MEMORY_RECALL_LAG_ALARM_SEC || 600);

async function runLagCanary() {
  try {
    const { canaryEnabled, lagObservation, appendCanary } = await import('../lib/recall-canary.js');
    if (!canaryEnabled()) return;
    const { rootsForCorpus, stagingIndexPath } = await import('../lib/config.js');
    const obs = lagObservation({ storeRoots: rootsForCorpus('staging'), stagingIndexPath: stagingIndexPath() });
    for (const row of obs.rows) {
      appendCanary(row);
      if (row.lagSec > LAG_ALARM_SEC) {
        appendCanary({ kind: 'alarm', reason: 'lag', file: row.file, lagSec: row.lagSec,
          writtenAt: row.writtenAt, visibleAt: row.visibleAt, thresholdSec: LAG_ALARM_SEC });
      }
    }
    appendCanary({ kind: 'tick', trigger: 'timed-capture', watched: obs.watched, visible: obs.visible,
      pending: obs.pending, storeFiles: obs.storeFiles, indexBuiltAt: obs.indexBuiltAt,
      certainlyMissing: obs.certainlyMissing, lagRows: obs.rows.length,
      ...(obs.seeded ? { seeded: true } : {}), costMs: obs.costMs });
    if (obs.rows.length || obs.pending) {
      console.log(`[recall-canary] ${obs.watched} newest store file(s): ${obs.visible} visible, ` +
        `${obs.pending} not yet indexed; ${obs.rows.length} lag row(s) in ${obs.costMs} ms`);
    }
  } catch (e) {
    console.error(`[recall-canary] skipped: ${e?.message || e}`);
  }
}

// ---- THE RECONCILE PASS (the actuator the crash detector needs) -------------------------------
//
// Wrapped whole and always awaited before the canary, so the canary's observation includes a repair
// this tick just made. --dry inspects and writes nothing, so it does not reconcile either.
async function reconcilePass() {
  if (DRY) return null;
  try {
    const { reconcileIfBehind } = await import('../lib/reconcile.js');
    const r = await reconcileIfBehind({ force: forceReconcile,
      log: (m) => console.log(`[timed-capture] ${m}`) });
    if (r.outcome === 'reconciled') {
      console.log(`[timed-capture] staging index rebuilt: ${r.indexedDocs} docs, ${r.indexedChunks} chunks ` +
        `(${r.reason}; store held ${r.storeFiles}, the index header claimed ${r.indexFiles})`);
    } else if (r.outcome === 'failed') {
      console.error(`[timed-capture] reconcile failed: ${r.error}`);
    }
    return r;
  } catch (e) {
    // A reconcile that cannot even load must never be the reason a walk did not happen.
    console.error(`[timed-capture] reconcile skipped: ${e?.message || e}`);
    return null;
  }
}

const selected = activeTranscripts();
const deferred = Math.max(0, selected.length - MAX_SESSIONS);
const active = selected.slice(0, MAX_SESSIONS);
// ONE LINE PER WALK, whatever the outcome: the sessions this walk will never take, and why. Said
// once here rather than per transcript, and carried on the terminal run-log row, so a reader of
// either can tell "eleven uncaptured" from "seven uncaptured and four that are not conversations".
const excludedRow = excluded.count ? { excluded: { count: excluded.count, reasons: excluded.reasons } } : {};
if (excluded.count) {
  console.log(`[timed-capture] ${excluded.count} session(s) excluded from capture: ` +
    Object.entries(excluded.reasons).map(([k, n]) => `${k}=${n}`).join(', '));
}
if (!active.length) {
  console.log('[timed-capture] every transcript is captured up to its current size; nothing to capture');
  const rec = await reconcilePass();
  await runLagCanary();
  walkerFinished({ sessions: 0, deferred: 0, why: 'nothing uncaptured', ...excludedRow,
    ...(rec ? { reconcile: rec.outcome, ...(rec.reason ? { reconcileReason: rec.reason } : {}) } : {}) });
  process.exit(0);
}

console.log(`[timed-capture] ${active.length} uncaptured session(s)` +
  (deferred ? `, ${deferred} deferred to the next run (cap ${MAX_SESSIONS})` : ''));
const childEnv = forceReconcile ? { ...process.env, MEMORY_FORCE_RECONCILE: '1' } : process.env;
let failedSessions = 0;
for (const t of active) {
  console.log(`[timed-capture] ${t.session} (${t.ageMin.toFixed(1)} min ago, ` +
    `${t.everCaptured ? `+${t.grownBytes} bytes` : 'never captured'}` +
    `${t.deferredInFlight ? ', in-flight exchange deferred by the last run' : ''})${DRY ? ' — DRY' : ''}`);
  if (DRY) continue;
  // Each session is independent: one that fails must not stop the others.
  const r = spawnSyncHidden(process.execPath, [join(ROOT, 'scripts', 'auto-ingest.js'), t.path, '--timed'],
    { encoding: 'utf8', env: childEnv, cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (r.status !== 0) {
    const tail = String(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ');
    console.error(`[timed-capture] ${t.session} exited ${r.status}: ${tail.slice(0, 200)}`);
    failedSessions++;
  }
}

// After the per-session loop, so both see anything this tick just wrote. The reconcile is usually a
// no-op here — a child that captured has already rebuilt — but a tick whose every child FAILED, or
// whose children all skipped on their own debounce, is exactly a tick where the store can be ahead
// of the index and nobody has looked.
const rec = await reconcilePass();
await runLagCanary();
walkerFinished({ sessions: active.length, deferred, failed: failedSessions, ...excludedRow,
  ...(rec ? { reconcile: rec.outcome, ...(rec.reason ? { reconcileReason: rec.reason } : {}) } : {}) });
