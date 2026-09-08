#!/usr/bin/env node
// scripts/analyse-query-log.js — the only ground truth about whether the guidance works.
//
// Every response this server sends carries advice: use `latest` for state
// questions, query with identifiers, read `threadLast`. All of it is STATIC TEXT.
// It advertises capability without ever learning whether anyone followed it, and a
// previous session wrote exactly that down as the open gap.
//
// The query log closes it, without a classifier and without judgment. It already
// records, for every query: the text, the mode, whether anything matched strongly,
// and when. A failure followed within seconds by a similar query is a caller who
// had to retry -- and whether the RETRY succeeded is the measurement. Nothing here
// infers meaning from language; it counts events that already happened.
//
// Read-only. Prints a report; never edits the corpus or the log.

import { readFileSync, existsSync } from 'node:fs';
import { queryLogPath } from '../lib/config.js';
import { benchmarkStrings } from '../lib/benchmark-strings.js';
import { pathToFileURL } from 'node:url';

const RETRY_WINDOW_MS = Number(process.env.QLOG_RETRY_WINDOW_MS || 180000);   // 3 minutes

// ---- WHAT COUNTS AS THE SUITE'S OWN TRAFFIC --------------------------------
//
// Measured 2026-09-05 over the two current logs: of 306 rows labelled
// `src:'live'`, 288 (94.1%) were the suite's own — 162 from a child process that
// set MEMORY_QUERY_SOURCE='live' by hand, 81 from a log line the suite APPENDED
// itself, 36 from the e2e stdio driver, 9 from a fuzz probe. Eighteen were a
// person. `src` alone cannot see any of that, because every one of those rows
// honestly crossed (or claimed) the MCP boundary.
//
// `runId` can: lib/config.js:runId() stamps MEMORY_RUN_ID on every row, and
// test/run-tests.js:17 sets it to `suite-<ms>-<rand>` for the whole run. So a
// row whose runId starts with `suite-` is suite output BY CONSTRUCTION, whatever
// its src says.
//
// 🟥 A ROW WITH NO runId IS NOT SUITE TRAFFIC. Pre-runId rows and hand-built
// fixtures (test/run-tests.js:4012/4025) carry none, and treating "no id" as
// "the suite" would silently delete the only real callers this log has.
//
// One predicate, three call sites — the three inline copies of this filter had
// already drifted apart once.
export function isSuiteRow(r) {
  return r.src === 'test' || r.src === 'unknown' || /^suite-/.test(String(r.runId || ''));
}

// 🟥 AND THE SUITE IS NOT THE ONLY NON-CALLER. The recall canary (lib/recall-canary.js) issues a
// real latest() inside the running server every five minutes that something is unindexed, tagged
// `src:'canary'`. `callerStats` below already drops it — it requires src==='live' — but the two
// DISPLAY filters did not, so the monitor would have been counted as up to 288 questions a day and
// every honest N/A of its own as a caller failure. A monitor that inflates the number it monitors
// is the same defect class isSuiteRow was written for.
const MONITOR_SRC = new Set(['canary']);
export function isMonitorRow(r) { return MONITOR_SRC.has(r.src); }
/** Traffic this system generated about itself: the suite, or a monitor. Never a person. */
export function isSelfTraffic(r) { return isSuiteRow(r) || isMonitorRow(r); }

// ---- CALLER-LEVEL STATS (Phase 1a) -----------------------------------------
// The row is the wrong unit: a multi-scope call writes one row per corpus, so
// counting rows over-reported failure (measured: 180 "live" rows in the frozen
// 08-26/27 window were 26 real questions). The unit is the CALLER QUESTION:
//   - rows sharing a queryId are one question (new rows);
//   - rows without one (pre-fix era) join by their exact query string — the
//     only honest join key that old format left us.
// GENUINE means src:'live' AND not a benchmark string: eval:state and the gold
// scorers drive the real handler, so their rows are honestly live — the
// committed question sets (both eval arms included) are what tells them apart.
// A TRUE MISS is a question for which EVERY row failed — one scope coming up
// empty while another answered is scope_empty routing detail, not a miss.
export function callerStats(rows, { preStamped = false } = {}) {
  const bench = benchmarkStrings();
  const failedRow = (r) => Boolean(r.noStrongMatch) || r.totalCandidates === 0;
  const groups = new Map();   // key -> { q, rows }
  for (const r of rows) {
    // `src === 'live'` is still required — an untagged row is not a caller — and
    // isSuiteRow removes the 94% of `live` that was the suite wearing the label.
    if (r.src !== 'live' || isSuiteRow(r)) continue;
    const isBench = preStamped ? Boolean(r.benchmarkQuery)
      : (Boolean(r.benchmarkQuery) || bench.has(String(r.q || '').toLowerCase()));
    if (isBench) continue;
    const key = r.queryId || `legacy:${String(r.q || '').toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { q: r.q, rows: [] });
    groups.get(key).rows.push(r);
  }
  // Legacy keying folds every repeat of a string into one question; queryId
  // keying counts repeats separately. Both report the same MISS semantics:
  // a question whose every row failed. For legacy misses that also means the
  // phrasing never once succeeded in the window.
  const questions = [...groups.values()];
  const misses = questions.filter((g) => g.rows.every(failedRow));
  return {
    genuine: questions.length,
    misses: misses.length,
    missList: misses.map((g) => ({
      q: g.q,
      rows: g.rows.length,
      kinds: [...new Set(g.rows.map((r) => r.failKind || (r.totalCandidates === 0 ? 'scope_empty' : 'no_strong_match')))]
    })),
    scopeEmptyOnly: questions.filter((g) => !g.rows.every(failedRow) && g.rows.some((r) => r.totalCandidates === 0)).length
  };
}

// ── CLI GUARD ───────────────────────────────────────────────────────────────
// Everything below runs the full report. Without this guard, `import`ing this file
// to reuse queryLogSummary() would print the entire report as a side effect —
// which is exactly what dream would have done.
const RUN_AS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// --log <path>   analyse a specific file (e.g. the preserved archive)
// --window <fromISO> <toISO>   restrict rows to fromISO <= ts < toISO
const argVal = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? null : process.argv[i + 1]; };
const path = RUN_AS_CLI ? (argVal('--log') || queryLogPath()) : null;
if (RUN_AS_CLI && !existsSync(path)) {
  console.log('\nNo query log at ' + path + ' — nothing to analyse yet.\n');
  process.exit(0);
}

if (RUN_AS_CLI) {
  let rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn final line is normal */ }
  }
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const winFrom = argVal('--window');
  const winTo = winFrom ? process.argv[process.argv.indexOf('--window') + 2] : null;
  if (winFrom && winTo) rows = rows.filter((r) => String(r.ts) >= winFrom && String(r.ts) < winTo);

  // ---- THE HEADLINE: caller questions, not rows ----
  {
    const cs = callerStats(rows);
    console.log('\n=== caller-level (one question = one queryId; legacy rows join by string) ===');
    console.log('  genuine caller queries : ' + cs.genuine + '   (src live, benchmark strings excluded)');
    console.log('  true misses            : ' + cs.misses + '   (EVERY row of the question failed)');
    console.log('  scope-empty-only       : ' + cs.scopeEmptyOnly + '   (some corpus empty, but the caller got an answer — not misses)');
    for (const m of cs.missList) console.log('    MISS  [' + m.kinds.join(',') + ']  «' + String(m.q).slice(0, 70) + '»');
  }

  // Rows written before src tagging existed cannot be attributed, so they are shown
  // separately rather than silently counted as live traffic.
  const ALL = process.argv.includes('--all');
  const untagged = rows.filter((r) => r.src === undefined).length;
  const bySrc = rows.filter((r) => r.src === 'test' || r.src === 'unknown').length;
  // Rows the src tag called live (or left untagged) that the run id convicts.
  const byRunId = rows.filter((r) => isSuiteRow(r) && r.src !== 'test' && r.src !== 'unknown').length;
  const testRows = bySrc + byRunId;
  const monitorRows = rows.filter(isMonitorRow).length;
  const live = ALL ? rows : rows.filter((r) => !isSelfTraffic(r));

  const failed = (r) => Boolean(r.noStrongMatch) || (r.totalCandidates === 0);
  const terms = (q) => String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];

  console.log('\n=== query log: what callers actually did ===\n');
  console.log('  log      : ' + path);
  console.log('  queries  : ' + live.length + (live.length ? '   (' + String(live[0].ts).slice(0, 10) +
    ' .. ' + String(live[live.length - 1].ts).slice(0, 10) + ')' : ''));
  console.log('  excluded : ' + testRows + ' suite traffic  (' + bySrc + ' by src tag, ' +
    byRunId + ' by runId ^suite- despite claiming live)' +
    (monitorRows ? '   |  ' + monitorRows + ' recall-canary probe(s)' : '') +
    (untagged ? '   |  ' + untagged + ' untagged (written before src tagging; counted as live)' : '') +
    (ALL ? '   [--all: NOTHING excluded]' : ''));
  const fails = live.filter(failed);
  console.log('  failures : ' + fails.length + '  (' + (100 * fails.length / (live.length || 1)).toFixed(1) + '%)  ' +
    '— no strong match, or nothing to rank at all');

  // ---- RETRIES: a failure followed by a related query is a caller working around us
  let retried = 0, recovered = 0;
  const unrecovered = [];
  for (let i = 0; i < live.length; i++) {
    if (!failed(live[i])) continue;
    const t0 = Date.parse(live[i].ts) || 0;
    const a = new Set(terms(live[i].q));
    let sawRetry = false, sawWin = false;
    for (let j = i + 1; j < live.length; j++) {
      const dt = (Date.parse(live[j].ts) || 0) - t0;
      if (dt > RETRY_WINDOW_MS) break;
      const shared = terms(live[j].q).some((t) => a.has(t));
      if (!shared) continue;
      sawRetry = true;
      if (!failed(live[j])) { sawWin = true; break; }
    }
    if (sawRetry) { retried++; if (sawWin) recovered++; else unrecovered.push(live[i]); }
  }
  console.log('\n  --- retries (a failure, then a related query within ' + (RETRY_WINDOW_MS / 60000) + ' min) ---');
  console.log('  retried after failing : ' + retried);
  console.log('  ...and then SUCCEEDED : ' + recovered + (retried ? '  (' + (100 * recovered / retried).toFixed(0) + '%)' : ''));
  console.log('  ...never recovered    : ' + (retried - recovered) +
    '   <- these are the questions this corpus could not answer at all');

  // ---- WHICH QUERIES KEEP FAILING (normalised, so near-duplicates collapse)
  const byShape = new Map();
  for (const r of fails) {
    const key = terms(r.q).sort().join(' ');
    if (!key) continue;
    if (!byShape.has(key)) byShape.set(key, { n: 0, example: r.q });
    byShape.get(key).n++;
  }
  const worst = [...byShape.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  if (worst.length) {
    console.log('\n  --- most-repeated failing queries ---');
    if (untagged) {
      console.log('  ⚠ ' + untagged + ' rows predate src tagging and CANNOT be attributed. The suite fires');
      console.log('    deliberate absence probes ("widget calibration", "when is the CEO\'s birthday"),');
      console.log('    so high-count entries below are probably fixtures, not real failures. This list');
      console.log('    only becomes trustworthy once the log has accumulated tagged rows.');
    }
    for (const w of worst) console.log('  ' + String(w.n).padStart(4) + 'x  «' + String(w.example).slice(0, 78) + '»');
  }

  // ---- TERMS THAT NEVER APPEAR IN A SUCCESS: vocabulary the corpus does not share
  const inWin = new Map(), inFail = new Map();
  for (const r of live) {
    const target = failed(r) ? inFail : inWin;
    for (const t of new Set(terms(r.q))) target.set(t, (target.get(t) || 0) + 1);
  }
  const deadTerms = [...inFail.entries()]
    .filter(([t, n]) => n >= 3 && !inWin.has(t))
    .sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (deadTerms.length) {
    console.log('\n  --- words that appear ONLY in failing queries (>=3 times) ---');
    console.log('  These are vocabulary the corpus does not share. Either the work was never');
    console.log('  described that way, or it is genuinely absent — worth knowing which.');
    console.log('  ' + deadTerms.map(([t, n]) => t + '(' + n + ')').join(', '));
  }

  // ---- MODE SPLIT: is `latest` being used for state questions, or is search still doing it?
  const byMode = new Map();
  for (const r of live) byMode.set(r.mode || 'search', (byMode.get(r.mode || 'search') || 0) + 1);
  console.log('\n  --- mode split (is the guidance changing behaviour?) ---');
  for (const [m, n] of [...byMode].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + String(m).padEnd(12) + String(n).padStart(6) + '  ' + (100 * n / (live.length || 1)).toFixed(1) + '%');
  }
  console.log('\n  Re-run after a week of use: a rising `latest` share and a falling never-recovered');
  console.log('  count are the only evidence that the advice in the tool description does anything.\n');

  // ── A three-line summary, for dream's report ───────────────────────────────
  //
  // This script reads thousands of rows and prints a full report, and NOTHING ever
  // scheduled it — so the only instrument that can say whether the guidance in the
  // tool description changes behaviour was one nobody ran. dream runs daily now, so
  // it carries the headline.
}

export function queryLogSummary() {
  const path = queryLogPath();
  if (!path || !existsSync(path)) return null;
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn final line is normal */ }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  // benchmarkQuery rows are our own gold/eval traffic driven through the real
  // handler — honestly src:'live', still not a caller. Excluded here the same
  // way callerStats excludes them.
  const live = rows.filter((r) => !isSelfTraffic(r) && !r.benchmarkQuery);
  const caller = callerStats(rows);
  const failed = (r) => Boolean(r.noStrongMatch) || r.totalCandidates === 0;
  const terms = (q) => String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];

  let retried = 0, recovered = 0;
  for (let i = 0; i < live.length; i++) {
    if (!failed(live[i])) continue;
    const t0 = Date.parse(live[i].ts) || 0;
    const a = new Set(terms(live[i].q));
    let sawRetry = false, sawWin = false;
    for (let j = i + 1; j < live.length; j++) {
      if ((Date.parse(live[j].ts) || 0) - t0 > 180000) break;
      if (!terms(live[j].q).some((t) => a.has(t))) continue;
      sawRetry = true;
      if (!failed(live[j])) { sawWin = true; break; }
    }
    if (sawRetry) { retried++; if (sawWin) recovered++; }
  }
  const byMode = new Map();
  for (const r of live) byMode.set(r.mode || 'search', (byMode.get(r.mode || 'search') || 0) + 1);
  const latestShare = (byMode.get('latest') || 0) / Math.max(1, live.length);
  const untagged = rows.filter((r) => r.src === undefined).length;

  return {
    queries: live.length,
    failures: live.filter(failed).length,
    retried,
    neverRecovered: retried - recovered,
    latestShare: Number((latestShare * 100).toFixed(1)),
    untagged,
    caller,
    lines: [
      `callers      : ${caller.genuine} genuine caller questions, ${caller.misses} true misses (every scope failed)`,
      `queries      : ${live.length} live rows, ${live.filter(failed).length} found nothing strong  (rows ≠ questions — fan-out)`,
      `retries      : ${retried} retried after failing, ${retried - recovered} NEVER recovered  <- the questions this corpus could not answer`,
      `mode split   : latest ${(latestShare * 100).toFixed(1)}%  (rising = the state-question guidance is being followed)` +
        (untagged ? `   [${untagged} rows predate src tagging and cannot be attributed]` : '')
    ]
  };
}
