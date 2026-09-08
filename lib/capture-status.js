// lib/capture-status.js — WHICH CONVERSATIONS EXIST BUT WERE NEVER WRITTEN DOWN?
//
// 🟥 THE BLIND SPOT THIS CLOSES. Every honesty channel in this project compares the INDEX against
// the STORE — checkStaleness (lib/freshness.js:103) diffs corpus files against idx.docs, and
// recencyVoid, foundInUnindexed and indexStale are all downstream of it. Not one of them compares
// the store against the TRANSCRIPT. So an exchange that was never EXTRACTED — a session that ended
// on a usage limit with no hook, a laptop asleep past the capture window, a run killed before the
// extractor wrote — is invisible to all of them. The response does not go stale. It goes QUIET,
// which is the failure mode this whole architecture exists to refuse.
//
// The signal is already on disk. store/.last-ingest.json holds `{at, size}` per transcript PATH:
// the size the extractor read, deliberately recorded before it read it (scripts/auto-ingest.js).
// A transcript larger than its stamp holds turns nobody captured; a transcript with no stamp at all
// has never been captured. One readdir plus one stat per transcript — ~141 files on this machine.
//
// COST AND SAFETY. Stat-only, never reads a transcript's contents, and NEVER THROWS: on any
// failure it returns an empty array carrying an `error` property, because a channel whose job is
// to prevent a confident wrong answer must not be able to cause one.
//
// 🟥 THE MEMO IS VERIFIED, NOT TIMED (MEM-48 / A-D3, campaign A, 2026-09-05). It used to be a flat
// 60 s TTL keyed on the PATHS, with nothing that invalidated it when a transcript GREW. So for up
// to a minute after an exchange landed, a query about that exchange got a response naming OTHER
// sessions as behind and silently omitting this one — the dominant DISHONEST cause in both soak
// runs. Measured, no server and no model: capture two sessions, grow A, ask (named: none), grow B,
// ask (named: none); drop the memo at the same instant and both are named.
//
// The memo could not be fixed by shortening it, because the thing it was hiding is the thing it
// was keyed on. So the stat walk — one readdir per project dir plus one stat per transcript, the
// whole cost this function has — now runs on EVERY call and IS the invalidation: its
// (path, size, mtime) list plus the stamp file's own (mtime, size) is the memo key. A grown
// transcript, a new session, a capture that rewrote the stamps: each changes the key and the
// answer is recomputed at once. What the memo still saves is the stamps read + JSON.parse and the
// array construction, and it still returns the IDENTICAL object when nothing on disk moved.
// MEMORY_CAPTURE_STATUS_TTL_MS caps how long an unchanged answer may be reused (default 5 s, 0
// disables the memo) — a ceiling on top of the check, never a substitute for it.
//
// CROSS-CHECK. lib/store-audit.js audit() computes the same "missing" set offline by re-running the
// extractor over each transcript. That is the expensive, exact version; this is the cheap one that
// can run per query. They should agree, and a disagreement is worth a look at whichever changed.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { ownStoreDir } from './config.js';
import { excludedSessionReason } from './capturable.js';

const DEFAULT_TTL_MS = 5_000;
/** Beyond this, a transcript with no stamp is history, not a gap. Same bound as the timer's cap. */
const DEFAULT_MAX_AGE_DAYS = 7;

/** The memo ceiling, read per call so a test (or an operator) can move it without a restart.
 *  0 or a negative value disables the memo; anything unparseable falls back to the default. */
export function captureStatusTtlMs() {
  const raw = process.env.MEMORY_CAPTURE_STATUS_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_TTL_MS;
}

let CACHE = null;      // { key, sig, at, value }

/** Drop the memo — for tests, and for anything that has just captured. */
export function forgetCaptureStatus() { CACHE = null; }

/**
 * Sessions whose transcript holds more than the store does.
 *
 * @param stampsPath      store/.last-ingest.json
 * @param transcriptDirs  the project directories holding *.jsonl transcripts
 * @param ttlMs           memo window; 0 disables the memo
 * @param maxAgeDays      ignore transcripts untouched for longer than this
 * @returns Array<{session, transcriptPath, grownBytes, capturedBytes, liveBytes, lastCaptureAt}>
 *          newest transcript first, carrying `.excluded = {count, reasons}` for the sessions
 *          capture will never take. On failure: an empty array with `.error` set.
 */
export function uncapturedSessions({ stampsPath, transcriptDirs = [], ttlMs = captureStatusTtlMs(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = Date.now() } = {}) {
  const key = `${stampsPath}\n${(transcriptDirs || []).join('\n')}\n${maxAgeDays}`;

  const out = [];
  const exc = { count: 0, reasons: {} };
  out.excluded = exc;
  try {
    // ---- THE WALK, WHICH IS ALSO THE INVALIDATION (MEM-48) --------------------------------
    // Everything this function costs is here, and it runs before the memo is consulted rather
    // than after, so a transcript that grew inside the window cannot be memoised away.
    const cutoff = now - maxAgeDays * 86_400_000;
    const live = [];
    for (const dir of transcriptDirs || []) {
      let names = [];
      try { names = readdirSync(dir); } catch { continue; }        // a project dir that vanished
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue;
        const full = join(dir, f);
        let st; try { st = statSync(full); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        live.push({ full, name: f, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    // The stamp file's own identity: a capture that caught a session up rewrites it, and that
    // must retire the warning in the same instant it stops being true.
    let sstat = null;
    try { if (stampsPath) sstat = statSync(stampsPath); } catch { sstat = null; }
    const sig = `${sstat ? `${sstat.mtimeMs}:${sstat.size}` : 'no-stamps'}|${live.length}|` +
      live.map((f) => `${f.full}:${f.size}:${f.mtimeMs}`).join(',');
    if (CACHE && ttlMs > 0 && CACHE.key === key && CACHE.sig === sig && now - CACHE.at < ttlMs) {
      return CACHE.value;
    }

    let stamps = {};
    if (stampsPath && existsSync(stampsPath)) {
      try { stamps = JSON.parse(readFileSync(stampsPath, 'utf8')) || {}; } catch { stamps = {}; }
    }
    for (const f of live) {
      const stamp = stamps[f.full];
      const capturedBytes = stamp && Number.isFinite(stamp.size) ? stamp.size : 0;
      // SIZE, NOT MTIME — deliberately the same signal the ingest debounce uses
      // (scripts/auto-ingest.js). A transcript is touched by things that add no turns; growth
      // past the size the extractor actually read is the only evidence of uncaptured content.
      if (stamp && f.size <= capturedBytes) continue;
      // 🟥 A SESSION THE WRITER WILL NEVER TAKE IS NOT "UNCAPTURED" (MEM-78). The note this array
      // feeds promises "captured by the next timer tick", and for a `<scheduled-task …>` transcript
      // that promise is false for ever: scripts/auto-ingest.js refuses it by design, so the count
      // sat at 11 on this machine with four of them permanently in it. They are not counted and not
      // named — but they ARE summarised on `.excluded`, because a reader who can see 68–442 KB of
      // ungrown transcript deserves to know it was a decision and not a gap. Same predicate the
      // writer and the walker use, so the three cannot drift apart again.
      const why = excludedSessionReason(f.full);
      if (why) { exc.count++; exc.reasons[why] = (exc.reasons[why] || 0) + 1; continue; }
      out.push({
        session: basename(f.name, '.jsonl'),
        transcriptPath: f.full,
        grownBytes: f.size - capturedBytes,
        capturedBytes,
        liveBytes: f.size,
        lastCaptureAt: stamp && Number.isFinite(stamp.at) ? new Date(stamp.at).toISOString() : null,
        mtimeMs: f.mtimeMs
      });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (ttlMs > 0) CACHE = { key, sig, at: now, value: out };
    return out;
  } catch (e) {
    // A failure is never memoised: there is no signature to trust, and remembering it would turn
    // one bad stat into a window of silence.
    CACHE = null;
    const empty = [];
    empty.error = String(e && e.message || e).slice(0, 200);
    return empty;
  }
}

// ---- THE ZERO-ARGUMENT FORM, for a read path -------------------------------------------------
//
// A caller on the query path should not have to know where transcripts live or what the stamp file
// is called; it has one question. These two resolve this install's paths the same way
// scripts/auto-ingest.js does (MEMORY_TRANSCRIPT_DIR wins, then every project folder under
// ~/.claude/projects) so the reader and the writer cannot disagree about which sessions exist.

/** Every directory Claude keeps transcripts in. */
export function transcriptDirs() {
  if (process.env.MEMORY_TRANSCRIPT_DIR) return [process.env.MEMORY_TRANSCRIPT_DIR];
  const root = join(homedir(), '.claude', 'projects');
  try { return readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(d)); }
  catch { return []; }
}

/**
 * The stamp a staging response carries when — and ONLY when — sessions exist that the store has
 * not caught up with. Null in the ordinary case, so a healthy answer grows by nothing at all.
 * Capped at 5 named sessions: this is a warning, not a work list.
 */
export function uncapturedSessionsStamp({ limit = 5, ...opts } = {}) {
  const store = ownStoreDir();
  if (!store) return null;
  const gaps = uncapturedSessions({ stampsPath: join(store, '.last-ingest.json'),
    transcriptDirs: transcriptDirs(), ...opts });
  // Nothing pending: no stamp, exactly as before. An excluded session is not pending, so a machine
  // whose only "gap" is four scheduled tasks now answers with nothing at all — which is the honest
  // answer and the one this stamp was always supposed to give.
  if (!gaps.length) return null;
  return {
    count: gaps.length,
    sessions: gaps.slice(0, limit).map((g) => ({ session: g.session, grownBytes: g.grownBytes,
      lastCaptureAt: g.lastCaptureAt })),
    // The sessions capture will never take, beside the ones it will. Present only when there are
    // any, so the ordinary answer is unchanged (MEM-78).
    ...(gaps.excluded && gaps.excluded.count
      ? { excludedSessions: { count: gaps.excluded.count, reasons: gaps.excluded.reasons,
          why: 'these transcripts are not conversations (scheduled tasks); capture refuses them by ' +
               'design, so they are NOT part of the count above and no tick will ever take them' } }
      : {}),
    note: 'NOT ABSENT — UNCAPTURED. These conversations have turns that were never written to the ' +
      'store, so no index check can see them and no search can return them. They are captured by ' +
      'the next timer tick (npm run capture) — a turn the transcript says has ENDED is taken on ' +
      'that tick, and one still being written waits for the tick after it has been quiet for 10 ' +
      'minutes (MEMORY_INFLIGHT_QUIET_MIN) — or by the Stop hook when that session next replies.'
  };
}
