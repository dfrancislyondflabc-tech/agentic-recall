// lib/capturable.js — IS THIS TRANSCRIPT A CONVERSATION SOMEBODY COULD WANT REMEMBERED?
//
// 🟥 MEM-78, found on the Mac 2026-09-05 in the first live use of 1.7.2. `uncapturedSessions`
// reported 11, four of them with `lastCaptureAt: null` and 68–442 KB grown, and named them under a
// note that reads "captured by the next timer tick". All four were `<scheduled-task …>` sessions
// (`bh-ds925-price-log`, `daily-maybe-review`), which scripts/auto-ingest.js refuses BY DESIGN. So
// the promise was false forever, and the walker spent its 8-slots-per-tick selecting transcripts it
// would then refuse — a wasted slot on every tick, on a machine with a real backlog.
//
// The cause is that the rule lived in ONE script. The writer refused them, the reader counted them,
// and the selector queued them, because there was nothing for the three to agree on. This module is
// that thing: one predicate, imported by all three, so a session that will never be captured is
// never PROMISED and never SELECTED.
//
// ---- WHAT IS IN, AND WHAT IS DELIBERATELY OUT --------------------------------------------------
//
// IN: the scheduled-task test, exactly as scripts/auto-ingest.js has always applied it — the first
// user turn, read out of the head of the file, and `MEMORY_CAPTURE_INCLUDE_TASKS=1` opts back in.
// It is a property OF THE TRANSCRIPT: deterministic, stable for the life of the file, and the same
// answer for every caller at every moment.
//
// OUT: the heartbeat-cold rule (`connectorRecentlyOn()`, scripts/auto-ingest.js). It is not a
// property of a transcript at all — it is one machine-wide fact about whether the connector has
// been on recently, it changes with the clock, and it applies to every session equally. Putting it
// here would make `excludedSessionReason(path)` return a different answer for the same file five
// minutes later, and would make `uncapturedSessions` claim a session is permanently unreachable
// when the truth is "not right now". A reader that needs it should ask the heartbeat directly.
//
// COST. One stat plus a 64 KB head read per transcript, memoised on (path, size, mtime) — so a
// long-lived reader (lib/capture-status.js runs on the QUERY path) pays it once per file per
// change, and the walker pays it only for the transcripts it was about to select anyway.

import { readFileSync, statSync } from 'node:fs';

/** Every reason a transcript is not capturable. Kept as a list so callers can group by it. */
export const EXCLUSION_REASONS = ['scheduled-task'];

const CACHE = new Map();        // `${path}:${size}:${mtimeMs}` -> reason | null

/** Drop the memo — for tests, and for anything that rewrites a transcript in place. */
export function forgetCapturable() { CACHE.clear(); }

/**
 * A scheduled task is a robot run, not a conversation, and must not become memory.
 *
 * Measured before the guard existed (2026-09-03): with MEMORY_CAPTURE_INCLUDE_TASKS=1, three of the
 * four scheduled-task sessions on this machine produce nothing (the extractor's own reply-length
 * rules decline them) and ONE produces a memory whose description is the raw
 * `<scheduled-task name="bh-ds925-price-log" file="...">` XML. Small, but it is corpus poisoning,
 * and it recurs on every run.
 *
 * Detection is the FIRST user turn, then stop. Reading only the head of the file keeps this cheap
 * on a multi-megabyte transcript, and a truncated tail line is not fatal.
 *
 * @param {string} path  a transcript (.jsonl)
 * @returns {null|'scheduled-task'} null when the transcript is capturable
 */
export function excludedSessionReason(path) {
  if (process.env.MEMORY_CAPTURE_INCLUDE_TASKS === '1') return null;
  let key = null;
  try {
    const st = statSync(path);
    key = `${path}:${st.size}:${st.mtimeMs}`;
    if (CACHE.has(key)) return CACHE.get(key);
  } catch { return null; }      // a file that cannot be stat'd is not a file we exclude
  let head;
  // A transcript this process cannot read is not a transcript it may declare uncapturable: the
  // safe direction for an EXCLUSION is to exclude nothing, because the writer will still refuse it
  // and the only cost is one honest line saying so.
  try { head = readFileSync(path, 'utf8').slice(0, 64 * 1024); } catch { return null; }
  let reason = null;
  for (const line of head.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const c = o.message && o.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text || '' : '';
    if (/^\s*<scheduled-task\b/.test(text)) reason = 'scheduled-task';
    break;                                            // decided by the FIRST user turn, then stop
  }
  if (key) CACHE.set(key, reason);
  return reason;
}

/** True when capture will consider this transcript at all. */
export function isCapturable(path) { return excludedSessionReason(path) === null; }

/**
 * Group a set of transcripts by why they are excluded, for the one line a reader needs.
 *
 * @param {string[]} paths
 * @returns {{count:number, reasons:Record<string,number>}} `{count: 0, reasons: {}}` when none are
 */
export function summariseExclusions(paths) {
  const reasons = {};
  let count = 0;
  for (const p of paths || []) {
    const r = excludedSessionReason(p);
    if (!r) continue;
    count++;
    reasons[r] = (reasons[r] || 0) + 1;
  }
  return { count, reasons };
}
