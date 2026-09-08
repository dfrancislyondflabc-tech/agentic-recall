// lib/ingest-health.js — DID THE LAST CAPTURE RUN FINISH, OR WAS IT KILLED?
//
// THE INCIDENT (2026-09-05, 04:52Z). A Stop-hook ingest wrote
// store/x-b58a69af-20260905T044521647Z.md and the host killed it before buildIndex ran. The run log
// records exactly that shape: a `started` line, then the process-exit handler's bare `exited`, and
// no `captured` / `no-op` / `failed` / `skipped` after either. Ninety minutes of work sat in the
// store, outside the index, and every reader was told it did not exist.
//
// That signature was READABLE the whole time — scripts/auto-ingest.js writes it deliberately (see
// the comment on runLog) — and nothing read it. This module reads it.
//
// WHAT IT DOES NOT DO. It never judges the CURRENT process, never touches the store, never
// rebuilds, and never throws. It answers one question from one append-only log, and the two
// consumers decide what to do about the answer: the timer forces a reconcile pass, and the read
// path stamps `captureHealth` beside a staging response so a reader is told that capture itself —
// not indexing — may be behind.
//
// COST. The last 64 KB of the log, ~450 lines, one open + one read. Nothing is parsed twice.

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ownStoreDir, stagingIndexPath } from './config.js';

/** Outcomes that TERMINATE a run. Anything else leaves the run unaccounted for. */
const TERMINAL = new Set(['captured', 'reconciled', 'no-op', 'skipped', 'failed']);
/** The two lines a killed run leaves behind: it started, and the exit handler fired (or not). */
const UNFINISHED = new Set(['started', 'exited']);

/**
 * 🟥 MEM-61 — WHAT CLOSES SOMEBODY ELSE'S CRASH, and why the dead pid's own log line never can.
 *
 * Measured (campaign A run 2, 2026-09-05): ingest pid 43387 was killed at t=1,025 s and RECONCILED
 * at t=1,385 s — the run log has the row — yet 669 responses right through to the end of the run,
 * 37.6 minutes later, still carried `captureHealth.healthy:false` naming that crash. The note beside
 * it said "the next timer tick reconciles", and the next timer tick had.
 *
 * The reason is structural rather than a slip: the repair is logged by the RECOVERING run, under
 * its OWN pid, carrying the dead one only as a `deadPid` field (scripts/auto-ingest.js:396). Group
 * the log by pid and the dead pid's `started` row is the last line it will ever have — so a
 * per-pid reader can only ever watch it stay open until it scrolls out of the 64 KB tail. A warning
 * that cannot be cleared is a warning nobody reads, and this is the honesty channel.
 *
 * So a crash is closed by WHAT HAPPENED AFTERWARDS, from any pid, and these are the rows that mean
 * the store and the index were compared and made to agree:
 *
 *   crash-recovered  the recovering run SAYING SO. It is one-shot and never debounced
 *                    (lib/reconcile.js:81, reason 'pending-marker'), so it is always followed by a
 *                    real rebuild rather than a deferral.
 *   reconciled       a rebuild ran over the whole staging corpus.
 *   captured         an ingest wrote and rebuilt. buildIndex() indexes the DIRECTORY, not one
 *                    session, so an orphan file the dead run left behind is picked up with it —
 *                    which is why a capture in a completely different session is still a repair.
 *
 * And these are NOT repairs, which is the distinction that keeps this honest:
 *
 *   no-op            "no new exchanges; index agrees" — but this run did NOT rebuild, and it is
 *                    reached by a run that never looked at the crash. A quiet tick is not a repair.
 *   skipped          a reconcile that was DEBOUNCED, i.e. deliberately not done.
 *   exited/started   another unfinished run.
 *
 * A WALK ALSO CLOSES IT, but only a walk that actually compared: scripts/timed-capture.mjs runs
 * reconcileIfBehind() on EVERY tick and records the verdict on its own `finished` row as
 * `reconcile: 'agrees' | 'reconciled' | 'debounced' | 'failed' | 'unavailable'`. `agrees` means the
 * live store listing digest matched the index header's; `reconciled` means it did not and a rebuild
 * fixed it. Either is proof. `debounced`, `failed` and a bare `finished` with no verdict are not,
 * and are deliberately excluded — the walker is not a writer and its mere survival proves nothing.
 */
const REPAIR = new Set(['crash-recovered', 'reconciled', 'captured']);
/** The two reconcile verdicts on a walker's `finished` row that mean store and index were compared. */
const WALK_VERIFIED = new Set(['agrees', 'reconciled']);

const DEFAULT_TAIL_BYTES = 64 * 1024;

export function ingestLogPath() {
  if (process.env.MEMORY_INGEST_LOG) return process.env.MEMORY_INGEST_LOG;
  const store = ownStoreDir();
  return store ? join(store, '.ingest-runs.jsonl') : null;
}

/**
 * The last N bytes of the run log, as parsed rows, oldest first.
 * A truncated first line (the tail rarely starts on a boundary) is dropped, not repaired.
 */
export function readRunLogTail(path, bytes = DEFAULT_TAIL_BYTES) {
  if (!path || !existsSync(path)) return [];
  let fd = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();                       // partial first line
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* a half-written last line is not an error */ }
    }
    return rows;
  } catch { return []; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* best effort */ } } }
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * Did a capture run die between writing and indexing?
 *
 * @param log           path to .ingest-runs.jsonl (defaults to this install's)
 * @param staleMinutes  how long a run may look unfinished before it counts as dead. A live run
 *                      legitimately shows `started` with nothing after it for as long as it takes
 *                      to embed, so this must be longer than a rebuild — 10 minutes is the same
 *                      bound the timer already uses to kill a child.
 * @returns {{crashed:boolean, at:string|null, session:string|null, pid:number|null, outcome:string|null}}
 */
export function lastRunCrashed({ log = ingestLogPath(), staleMinutes = 10, now = Date.now() } = {}) {
  const none = { crashed: false, at: null, session: null, pid: null, outcome: null };
  try {
    const rows = readRunLogTail(log);
    if (!rows.length) return none;

    // GROUPED BY PID, because the log interleaves. The timer fires one child per active session and
    // three are usually live, so the LAST LINE IN THE FILE is routinely somebody else's — reading it
    // alone would report a healthy run as crashed and a crashed one as healthy, in the same minute.
    const byPid = new Map();
    // MEM-61: WHERE the repairs are, in file order — which is time order, because every writer
    // appends. One pass, so the cost of the fix is one integer array and not a second read.
    const repairAt = [];
    const walkVerifiedAt = [];
    rows.forEach((r, i) => {
      if (!r || typeof r.outcome !== 'string') return;
      if (r.trigger === 'walker') {
        if (r.outcome === 'finished' && WALK_VERIFIED.has(r.reconcile)) walkVerifiedAt.push(i);
        return;
      }
      if (r.trigger === 'audit') return;
      if (REPAIR.has(r.outcome)) repairAt.push(i);
    });

    for (const r of rows) {
      if (!r || !Number.isInteger(r.pid)) continue;
      // 🟥 THE WALKER IS NOT A WRITER. scripts/timed-capture.mjs appends `started`/`finished` rows
      // of its own (trigger:'walker') so a walk and its ingests read as one story. It writes
      // nothing to the store and never touches an index, so a walk that was killed — which happens
      // every time a laptop sleeps mid-tick — cannot have left the store and the index
      // disagreeing. Counting its `started` row as a crash signature would force a redundant
      // reconcile AND stamp `captureHealth: unhealthy` onto every read response afterwards, for a
      // process whose death costs nothing. Its children log their own crashes as trigger:'timed'.
      if (r.trigger === 'walker') continue;
      // 🟥 NOR IS THE AUDIT (MEM-50). Same argument, one step stronger: lib/store-audit-tick.js
      // writes nothing to the store on its clean path, and its outcomes are `audit*` — none of
      // which are in TERMINAL or UNFINISHED, so the loop below would already ignore them. This
      // line makes that an intention rather than an accident of two set memberships, because the
      // accident is exactly how a walker row came to be read as a crashed ingest.
      if (r.trigger === 'audit') continue;
      byPid.set(r.pid, r);                              // last row wins, rows are in file order
    }

    let worst = null;
    for (const [pid, last] of byPid) {
      if (TERMINAL.has(last.outcome)) continue;         // it finished, whatever it decided
      if (!UNFINISHED.has(last.outcome)) continue;      // an outcome this module does not know
      if (alive(pid)) continue;                         // still working — not evidence of anything
      const atMs = Date.parse(last.at);
      if (Number.isFinite(atMs) && (now - atMs) / 60000 < staleMinutes) continue;
      // MEM-61: CLOSED BY WHAT CAME AFTER IT, from any pid. Without this the dead pid's `started`
      // row is a permanent crash signature — 669 responses stamped `unhealthy` 37.6 minutes after
      // the reconcile that fixed it — because the repair is never logged under the dead pid.
      const at = rows.indexOf(last);                    // identity, so it is THIS row's position
      if (repairAt.some((j) => j > at)) continue;       // a later capture/reconcile/crash-recovered
      if (walkVerifiedAt.some((j) => j > at)) continue; // ...or a walk that compared store to index
      if (!worst || Date.parse(last.at) > Date.parse(worst.at)) worst = last;
    }
    if (!worst) return none;
    return { crashed: true, at: worst.at ?? null, session: worst.session ?? null,
      pid: worst.pid ?? null, outcome: worst.outcome ?? null };
  } catch { return none; }
}

// ---- THE TWO CHANNELS THAT WERE WRITE-ONLY (MEM-50) ------------------------------------------
//
// Both of these have been written for weeks and read by nobody.
//
//   .vanish-report.jsonl   lib/index-store.js:295 records, on every incremental build, the
//                          documents that were in the LAST index and are gone from the corpus now.
//                          It exists because a warn() inside a hook goes to a stderr the host keeps
//                          nowhere (MEM-23). Writing it down was the right half of the fix; the
//                          other half — someone reading it — is here. Zero rows on this machine to
//                          date, which is the answer you want and not a reason to stop looking.
//
//   the audit rows         lib/store-audit-tick.js's hourly `audit` / `audit-alarm` /
//                          `audit-healed`. An alarm that only ever lands in a JSONL file is the
//                          same shape of mistake as the vanish report, made twice.
//
// Both ride out on `captureHealth`, which lib/search.js:256 already stamps onto every staging
// answer and which SECTION_KEYS (:2116) and EV_GROUP_KEEP (:1978) already carry WHOLE through the
// array-scope and compact views — so nothing in the read path needs to change to surface them.

export const DEFAULT_VANISH_REPORT_DAYS = 7;

/** Where lib/index-store.js writes the vanish report: beside the index it was building. */
export function vanishLogPath() {
  if (process.env.MEMORY_VANISH_LOG) return process.env.MEMORY_VANISH_LOG;
  const idx = stagingIndexPath();
  return idx ? join(dirname(idx), '.vanish-report.jsonl') : null;
}

/**
 * The last vanish row, if it is recent enough to still be news.
 *
 * A TORN LAST LINE IS TOLERATED, not repaired: readRunLogTail already drops anything that will not
 * parse, so a build killed mid-append costs the newest row and not the reader. Taking the last
 * PARSEABLE row rather than the last line is what makes that true.
 *
 * @returns {{lastAt:string, vanished:number, names:string[]}|null}
 */
export function lastVanish({ log = vanishLogPath(), days = Number(process.env.MEMORY_VANISH_REPORT_DAYS ?? DEFAULT_VANISH_REPORT_DAYS),
  now = Date.now() } = {}) {
  try {
    const rows = readRunLogTail(log);
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r || typeof r.at !== 'string' || !Number.isFinite(Number(r.vanished))) continue;
      const at = Date.parse(r.at);
      if (!Number.isFinite(at)) continue;
      if ((now - at) / 86_400_000 > Number(days)) return null;    // old news is not news
      return { lastAt: r.at, vanished: Number(r.vanished), names: (r.names || []).slice(0, 5) };
    }
    return null;
  } catch { return null; }
}

/**
 * What the store audit last said, and whether its last alarm is still standing.
 *
 * 🟥 "STILL STANDING" IS DECIDED BY WHAT CAME AFTER IT, NOT BY THE NEWEST ROW ALONE. An alarm is
 * closed by a later `audit-healed` (it was repaired) OR by a later plain `audit` (a fresh look
 * found nothing). It is NOT closed by `audit-skipped` or `audit-failed`, which is the case that
 * makes the distinction matter: a repair that could not take the walker lock appends a skip row
 * AFTER the alarm, and reading only the newest row would report that as resolved.
 *
 * @returns {{lastAt:string|null, outcome:string|null, missingStale:number, healed:number, alarmOpen:boolean}|null}
 */
export function lastAudit({ log = ingestLogPath() } = {}) {
  try {
    const rows = readRunLogTail(log).filter((r) => r && typeof r.outcome === 'string' && r.outcome.startsWith('audit'));
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    let openAlarm = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].outcome === 'audit-healed' || rows[i].outcome === 'audit') break;
      if (rows[i].outcome === 'audit-alarm') { openAlarm = rows[i]; break; }
    }
    const filesOf = (r) => (Array.isArray(r.healed)
      ? r.healed.reduce((n, h) => n + (Number(h && h.files) || 0), 0)
      : Number(r.wrote) || 0);
    // 🟥 THE COUNT COMES FROM THE ALARM, NOT FROM THE NEWEST ROW. `audit-skipped` and
    // `audit-failed` carry no missingStale, so reading the tail row reported an OPEN alarm as
    // "found 0 exchanges missing" — a sentence that says nothing is wrong while status says
    // otherwise. Whichever row is the news is the row the numbers come from.
    const news = openAlarm || last;
    return { lastAt: news.at ?? null, outcome: news.outcome, missingStale: Number(news.missingStale) || 0,
      healed: filesOf(news), alarmOpen: !!openAlarm, latestAt: last.at ?? null, latestOutcome: last.outcome };
  } catch { return null; }
}

/**
 * The small object a READ path stamps beside a staging answer.
 *
 * It says two things a reader cannot otherwise know: capture died partway (so material may be in
 * the store but not the index, or not even in the store), and a rebuild is currently owed (the
 * pending marker below). Both are ABSENT-not-false when there is nothing to report, so the common
 * case adds nothing to a response.
 *
 * Never throws, never blocks: two stats and a 64 KB read, and any failure resolves to
 * `{healthy:true}` because a health check that can fail a query is worse than no health check.
 */
export function captureHealth({ log = ingestLogPath(), store = ownStoreDir(), staleMinutes = 10,
  vanishLog = vanishLogPath(), vanishDays = Number(process.env.MEMORY_VANISH_REPORT_DAYS ?? DEFAULT_VANISH_REPORT_DAYS),
  now = Date.now() } = {}) {
  try {
    const crash = lastRunCrashed({ log, staleMinutes, now });
    const pendingPath = process.env.MEMORY_PENDING_INDEX || (store ? join(store, '.pending-index.json') : null);
    let pending = null;
    if (pendingPath && existsSync(pendingPath)) {
      try {
        const raw = JSON.parse(readFileSync(pendingPath, 'utf8'));
        if (raw && !alive(raw.pid)) pending = { at: raw.at ?? null, pid: raw.pid ?? null, session: raw.session ?? null };
      } catch { /* half-written marker */ }
    }

    const vanish = lastVanish({ log: vanishLog, days: vanishDays, now });
    const auditRow = lastAudit({ log });

    // WHAT COUNTS AS NEWS, and the two thresholds are deliberately different. A vanish row is
    // REPORTED for seven days (someone asking "when did those memories go" a week later is the
    // whole reason the log exists) but only makes the answer UNHEALTHY for one, because a
    // fortnight-old deletion is history, not an alarm about the answer being read right now.
    const vanishReportable = !!(vanish && vanish.vanished > 0);
    const vanishAcute = !!(vanishReportable && (now - Date.parse(vanish.lastAt)) / 3_600_000 < 24 && vanish.names.length >= 1);
    const auditAlarm = !!(auditRow && auditRow.alarmOpen);
    const auditHealedRecently = !!(auditRow && auditRow.outcome === 'audit-healed' && auditRow.healed > 0 &&
      (now - Date.parse(auditRow.lastAt)) / 3_600_000 < 24);

    if (!crash.crashed && !pending && !vanishReportable && !auditAlarm && !auditHealedRecently) return { healthy: true };

    const notes = [];
    if (crash.crashed || pending) {
      notes.push('a capture run did not finish — material may be in the store but not the index, or not captured at all. ' +
        'The next timer tick reconciles; scripts/timed-capture.mjs forces it immediately.');
    }
    if (vanishReportable) {
      notes.push(`${vanish.vanished} indexed files vanished from disk since the build at ${vanish.lastAt}: ` +
        vanish.names.join(', ') + (vanish.vanished > vanish.names.length ? `, …and ${vanish.vanished - vanish.names.length} more` : ''));
    }
    if (auditAlarm) {
      notes.push(`the hourly store audit found ${auditRow.missingStale} exchanges stamped as captured but missing` +
        (auditRow.healed ? `; ${auditRow.healed} repaired at ${auditRow.lastAt}` : '; none repaired yet'));
    } else if (auditHealedRecently) {
      notes.push(`the hourly store audit found ${auditRow.missingStale} exchanges stamped as captured but missing; ` +
        `${auditRow.healed} repaired at ${auditRow.lastAt}`);
    }

    return {
      // `healthy:false` is what lib/search.js:256 gates the whole stamp on, so it stays the field
      // that decides visibility. `status` is the three-way answer a reader actually wants: a
      // deletion nine days ago and an exchange missing right now are not the same news.
      healthy: false,
      status: (crash.crashed || pending || auditAlarm || vanishAcute) ? 'unhealthy' : 'degraded',
      ...(crash.crashed ? { lastRunCrashed: { at: crash.at, session: crash.session, pid: crash.pid, outcome: crash.outcome } } : {}),
      ...(pending ? { indexRebuildPending: pending } : {}),
      ...(vanishReportable ? { vanish: { lastAt: vanish.lastAt, vanished: vanish.vanished, names: vanish.names } } : { vanish: null }),
      ...(auditRow ? { audit: { lastAt: auditRow.lastAt, outcome: auditRow.outcome,
        missingStale: auditRow.missingStale, healed: auditRow.healed } } : {}),
      note: notes.join(' ')
    };
  } catch { return { healthy: true }; }
}
