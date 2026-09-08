// lib/store-audit-tick.js — THE ONE CHECK A LYING STAMP CANNOT FOOL.
//
// MEM-39, 2026-09-05. The suite's `capture` fixture wrote `store/.last-ingest.json` for the LIVE
// transcript at its full size. Nothing was deleted and nothing crashed; the next real capture
// simply looked at the stamp, decided the transcript had not grown, and skipped. Six exchanges did
// not exist anywhere, and every honesty channel this project has said everything was fine:
//
//   uncapturedSessions   transcript vs the STAMP        — the stamp was the liar
//   captureHealth        the run log vs itself          — the run ended cleanly, because it did
//   the recall canary    the store vs the INDEX         — the index matched the store exactly
//   the vanish report    this index vs the LAST index   — nothing vanished; nothing arrived
//
// Every one of them trusts either the stamp or a derived artefact. None compares the TRANSCRIPT to
// the STORE, and that is the only comparison in which a lying stamp has no vote at all:
// lib/store-audit.js re-runs the real extractor into a scratch directory and diffs the filenames.
// It reads `.last-ingest.json` never — which is the point of pointing it at this class of bug.
//
// 🟥 A `missing` ROW IS NOT AUTOMATICALLY AN ALARM, and getting that wrong would make this useless.
// The timed extractor runs with --defer-last, so the in-flight exchange of a live chat is missing
// BY DESIGN and will be written on the next pass; a session someone is typing in right now is
// always a few seconds behind. So `missing` is split in two by AGE, read out of the store filename
// (`x-<sid8>-<YYYYMMDDTHHmmssSSSZ>.md`): younger than MEMORY_STORE_AUDIT_GRACE_MIN (15 min) is
// normal operation and is counted, not shouted about; older than that is an exchange that has had
// every opportunity to be written and was not — the MEM-39 shape. The measured proof that the
// distinction is load-bearing: on this Mac, an audit of ALL 123 sessions found exactly one
// `missing`, and it was the auditing session's own in-flight exchange.
//
// WHAT IT DOES ABOUT IT. It re-runs the extractor for that transcript, into the real store, with no
// reference to the debounce stamp — the extractor is incremental (it writes any exchange whose file
// is missing), so the repair IS an ordinary capture, and it is the same binary the walker runs.
// Then one staging rebuild, through the same `buildIndex` entry point scripts/auto-ingest.js uses,
// so the repaired files are searchable rather than merely present. All of it under the WALKER LOCK,
// so a repair and a walk can never both be writing.
//
// It never throws. A detector that can take down the process it is detecting for is not a detector;
// every failure lands as one `audit-failed` row and the next tick tries again.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncHidden } from './child.js';   // MEM-83: no console window on Windows
import { audit, findTranscript, defaultTranscriptDirs } from './store-audit.js';
import { ingestLogPath } from './ingest-health.js';
import { storeDir, walkerLockAlive, acquireWalkerLock, releaseWalkerLock, auditLockPath,
         DEFAULT_AUDIT_GRACE_MIN, DEFAULT_AUDIT_MAX_SESSIONS, appendAuditRun } from './scheduler.js';

const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const off = (v) => ['0', 'false', 'off'].includes(String(v ?? '').toLowerCase());

/**
 * The ask-time of an exchange, read out of the store filename the extractor would have written.
 *
 * `x-<sid8>-<YYYYMMDDTHHmmssSSSZ>.md` — the format scripts/ingest-transcript.js emits. The name is
 * the only thing an audit has for a file that DOES NOT EXIST, which is exactly the case being aged
 * here, so it has to come from here and not from frontmatter.
 *
 * @returns {number|null} ms since epoch, or null when the name is not that shape
 */
export function exchangeTsFromName(file) {
  const m = /^x-[^-]+-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.md$/.exec(String(file || ''));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Split lib/store-audit.js's problem list into counts, and `missing` into expected vs alarming.
 *
 * A `missing` file whose name carries no parseable timestamp is counted as STALE. The conservative
 * direction for a detector is to look and find nothing, not to shrug at something it cannot age.
 *
 * @param {Array<{kind:string, session:string, file?:string}>} problems
 * @param {{now?:number, graceMin?:number}} o
 * @returns {{missing:number, missingStale:number, orphans:number, duplicates:number, order:number,
 *            dangling:number, other:number, staleBySession:Map<string,string[]>}}
 */
export function classifyProblems(problems, { now = Date.now(), graceMin = DEFAULT_AUDIT_GRACE_MIN } = {}) {
  const out = { missing: 0, missingStale: 0, orphans: 0, duplicates: 0, order: 0, dangling: 0, other: 0,
    staleBySession: new Map() };
  for (const p of problems || []) {
    switch (p && p.kind) {
      case 'missing': {
        out.missing++;
        const ts = exchangeTsFromName(p.file);
        const stale = ts === null || (now - ts) / 60000 > Number(graceMin);
        if (stale) {
          out.missingStale++;
          if (!out.staleBySession.has(p.session)) out.staleBySession.set(p.session, []);
          out.staleBySession.get(p.session).push(p.file);
        }
        break;
      }
      case 'orphan':         out.orphans++; break;
      case 'duplicate-body': out.duplicates++; break;
      case 'order':          out.order++; break;
      case 'dangling-prev':  out.dangling++; break;
      default:               out.other++;
    }
  }
  return out;
}

/** The extractor this install runs. Same rule as lib/scheduler.js walkerScript(): released copy first. */
export function extractorScript(codeRoot = CODE_ROOT) {
  if (process.env.MEMORY_INGEST_SCRIPT) return process.env.MEMORY_INGEST_SCRIPT;
  const released = join(codeRoot, 'dist', 'capture', 'scripts', 'ingest-transcript.js');
  if (existsSync(released)) return released;
  return join(codeRoot, 'scripts', 'ingest-transcript.js');
}

/**
 * REPAIR ONE SESSION, exactly the way a HOOK capture would — and deliberately not the way a TIMED
 * one would.
 *
 * 🟥 NO `--defer-last` HERE, and the flag is the whole reason this function exists rather than a
 * one-line spawn. scripts/auto-ingest.js:410 passes `--defer-last` on timed runs so the in-flight
 * exchange is not re-embedded every five minutes. But lib/store-audit.js's expected set comes from
 * an extractor run WITHOUT it, and only files older than the grace window reach this function at
 * all. Repairing with `--defer-last` would therefore refuse to write the one file shape that can
 * never fix itself: the final exchange of an ABANDONED session, where no later user turn will ever
 * arrive to make `lastStillWriting` false. That is an alarm that fires every hour and heals
 * nothing. Without the flag the extractor writes it and stamps `metadata.inFlight`, which is what
 * the Stop hook does at the end of every session and is self-clearing on any later rewrite.
 *
 * The debounce stamp lives in auto-ingest, not in the extractor, so invoking the extractor directly
 * IS the "ignore the stamp" this repair needs — no flag to pass, nothing to edit in the writer.
 * The repair path and the capture path are one binary.
 *
 * No `--backfill` either: this is a repair happening NOW on THIS machine, so the signed-in account
 * is the honest stamp — the same one the walker's capture of the same exchange would have written.
 *
 * @returns {number} how many of `expect` now exist that did not before
 */
function healOne({ transcript, store, extractor, expect = [], timeoutMs = 120_000 }) {
  execFileSyncHidden(process.execPath, [extractor, transcript, '--write'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MEMORY_OWN_STORE: store },
      timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  // COUNTED BY NAME, not as a delta of the directory count. A count difference credits the repair
  // with anything else that landed in the store during it and, worse, reads ZERO when the extractor
  // wrote the missing file and pruned an orphan in the same pass.
  return expect.filter((f) => existsSync(join(store, f))).length;
}

const mdCount = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; } };

/**
 * One audit tick. Never throws.
 *
 * @param {object} [o]
 * @param {string}   [o.store]
 * @param {string[]|null} [o.transcriptDirs]
 * @param {string}   [o.extractor]
 * @param {number}   [o.maxSessions]
 * @param {number}   [o.graceMin]
 * @param {number}   [o.now]
 * @param {boolean}  [o.heal]        MEMORY_STORE_AUDIT_HEAL=0 turns the repair off, keeping the report
 * @param {boolean}  [o.snapshot]    MEMORY_STORE_SNAPSHOT_HOURS=0 turns the daily snapshot off
 * @param {string}   [o.logPath]
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<object>} the row that was appended
 */
export async function runAuditTick({
  store = storeDir(),
  transcriptDirs = null,
  extractor = extractorScript(),
  maxSessions = Number(process.env.MEMORY_STORE_AUDIT_MAX_SESSIONS) || DEFAULT_AUDIT_MAX_SESSIONS,
  graceMin = Number(process.env.MEMORY_STORE_AUDIT_GRACE_MIN ?? DEFAULT_AUDIT_GRACE_MIN),
  now = Date.now(),
  heal = !off(process.env.MEMORY_STORE_AUDIT_HEAL),
  snapshot = true,
  logPath = ingestLogPath(),
  log = () => {}
} = {}) {
  const t0 = Date.now();
  const emit = (row) => { appendAuditRun(row, logPath); return row; };
  let heldAuditLock = false;
  try {
    if (!store || !existsSync(store)) {
      return emit({ outcome: 'audit-skipped', why: 'no capture store on this machine yet', ms: Date.now() - t0 });
    }
    // ONE AUDIT AT A TIME, ACROSS PROCESSES. Held for the whole tick, released in `finally`.
    const mine = acquireWalkerLock(auditLockPath());
    if (!mine.ok) {
      log('audit skipped: another audit is running');
      return emit({ outcome: 'audit-skipped', why: 'audit lock held', ms: Date.now() - t0 });
    }
    heldAuditLock = true;

    // A WALK IN PROGRESS IS A MOVING TARGET. Reading the store while the writer is in it produces
    // `missing` rows that are neither true nor false, and healing on top of it would be two
    // writers. The audit is hourly; losing one tick to a five-minute walk costs nothing.
    if (walkerLockAlive()) {
      log('audit skipped: a capture walk holds the lock');
      return emit({ outcome: 'audit-skipped', why: 'lock held', ms: Date.now() - t0 });
    }

    const r = audit({ storeDir: store, transcriptDirs, extractor, maxSessions });
    const c = classifyProblems(r.problems, { now, graceMin });
    const base = { sessions: r.sessions, skipped: r.skipped, missing: c.missing, missingStale: c.missingStale,
      orphans: c.orphans, duplicates: c.duplicates, order: c.order, dangling: c.dangling };

    if (!c.missingStale) {
      const row = emit({ outcome: 'audit', ...base, healed: [], ms: Date.now() - t0 });
      if (snapshot) await maybeSnapshot({ store, logPath, log });
      return row;
    }

    // 🟥 THE ALARM IS WRITTEN BEFORE THE REPAIR, and stays written after it. A repaired fault that
    // leaves no trace is a fault that gets to happen again unobserved — captureHealth reads the
    // PAIR (alarm, then healed) and can therefore say "found N, repaired N at <ts>" rather than
    // silently nothing.
    log(`audit ALARM: ${c.missingStale} exchange(s) stamped as captured but absent from the store`);
    const alarm = emit({ outcome: 'audit-alarm', ...base,
      sessionsAffected: [...c.staleBySession.keys()].map((s) => String(s).slice(0, 8)), ms: Date.now() - t0 });
    if (!heal) return alarm;

    const lock = acquireWalkerLock();
    if (!lock.ok) {
      log('audit repair skipped: a capture walk took the lock first');
      return emit({ outcome: 'audit-skipped', why: 'lock held', ...base, ms: Date.now() - t0 });
    }
    const healed = [];
    const dirs = transcriptDirs || defaultTranscriptDirs();
    try {
      for (const [sessionId, expect] of c.staleBySession) {
        const tx = findTranscript(sessionId, dirs);
        if (!tx) { healed.push({ session: String(sessionId).slice(0, 8), files: 0, why: 'transcript gone' }); continue; }
        try {
          const files = healOne({ transcript: tx, store, extractor, expect });
          healed.push({ session: String(sessionId).slice(0, 8), files });
        } catch (e) {
          healed.push({ session: String(sessionId).slice(0, 8), files: 0, error: String(e && e.message || e).slice(0, 160) });
        }
      }
      // ONE rebuild for the whole repair, through the entry point the writer already uses. Two
      // builds racing over one index is the mistake scripts/auto-ingest.js's lock exists to
      // prevent, so this runs inside the walker lock and nowhere else.
      const wrote = healed.reduce((n, h) => n + (h.files || 0), 0);
      let indexed = null;
      if (wrote) {
        const { buildIndex } = await import('./index-store.js');
        const { rootsForCorpus, stagingIndexPath } = await import('./config.js');
        const out = stagingIndexPath();
        if (out) {
          const rep = await buildIndex({ dir: rootsForCorpus('staging'), out });
          indexed = { docs: rep.filesIndexed, chunks: rep.chunkCount };
        }
      }
      log(`audit repaired ${wrote} exchange(s)`);
      const row = emit({ outcome: 'audit-healed', ...base, healed, wrote, storeFiles: mdCount(store),
        ...(indexed ? { indexed } : {}), ms: Date.now() - t0 });
      if (snapshot) await maybeSnapshot({ store, logPath, log });
      return row;
    } finally { releaseWalkerLock(); }
  } catch (e) {
    return emit({ outcome: 'audit-failed', error: String(e && e.message || e).slice(0, 300), ms: Date.now() - t0 });
  } finally {
    if (heldAuditLock) releaseWalkerLock(auditLockPath());
  }
}

/**
 * The daily copy of the store, run from the audit because the audit is the thing that already
 * knows the store is quiet. Failure is logged and swallowed: a backup that can stop a detector is
 * worse than no backup.
 */
async function maybeSnapshot({ store, logPath, log }) {
  try {
    const { snapshotStore } = await import('./store-snapshot.js');
    const r = snapshotStore({ store });
    if (r && r.wrote) {
      log(`store snapshot: ${r.files} file(s), ${r.bytes} bytes → ${r.file}`);
      appendAuditRun({ outcome: 'snapshot', file: r.file, files: r.files, bytes: r.bytes,
        pruned: r.pruned, ms: r.ms }, logPath);
    }
    return r;
  } catch (e) {
    try { appendAuditRun({ outcome: 'snapshot-failed', error: String(e && e.message || e).slice(0, 200) }, logPath); } catch { /* nothing left */ }
    return null;
  }
}

/** Exported for the tick script's cost line: how big the store is right now. */
export const storeFileCount = (dir) => { try { return statSync(dir).isDirectory() ? mdCount(dir) : 0; } catch { return 0; } };
