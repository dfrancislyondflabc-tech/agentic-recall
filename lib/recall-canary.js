// lib/recall-canary.js — DOES THE PIPELINE STILL ANSWER, AND HOW LATE IS IT?
//
// WHAT THIS IS FOR. Every fix in this release makes recent recall more reliable. None of them
// MEASURES it. The ten failures behind the release (MEM-1, -2, -16/17, -18, -19, -20/F3, -21, the
// 7-hour stale cache, the v121 miss, MEM-26/27) were each found by a person noticing a wrong answer,
// days later, by accident. Two numbers would have found all of them the same hour:
//
//   LAG      how long a written store file stays invisible to the index.
//   HONESTY  when a file IS invisible, does a query say so — or does it answer confidently and
//            name nothing? The second is the only failure this project treats as unacceptable.
//
// WHAT IT DELIBERATELY IS NOT (Daniel's ruling, 2026-09-05). It is a PASSIVE OBSERVER:
//   - it never writes a synthetic memory into the corpus (a canary file in the store would be
//     indexed, retrieved, and eventually read by somebody as if it were a real memory);
//   - it runs no LLM and starts no process — the lag half rides the 5-minute capture timer that
//     already runs, and the honesty half runs inside the server process that already holds the
//     index in RAM;
//   - it never fails its host. Every entry point is wrapped; a canary that can break capture or a
//     query is worse than no canary.
//
// COST, MEASURED against a copy of the LIVE store (2,908 files) and its 2,908-doc staging index
// (see test group (a77) and the WP8 report):
//   lag tick   one 4 KB index-header read (0.25 ms) + one stat pass over the store (22-24 ms) =
//              25-51 ms per tick. The index is NEVER parsed and no model is loaded.
//   probe      one checkStaleness (the same stat pass, TTL-cached in production) = 22.7-33 ms when
//              nothing is unindexed, and it returns null having written nothing; 71-95 ms when one
//              file IS unindexed, which additionally pays WP1's direct read and one in-process
//              latest() against an index that is ALREADY RESIDENT — measured +2.0 MB of heap, flat
//              from probe 1 to probe 20, against the 708 MB the resident index already costs.
//
// WHERE THE OUTPUT GOES. `store/.recall-canary.jsonl`, one JSON object per line, overridable with
// MEMORY_RECALL_CANARY_LOG (and therefore redirected by test/sandbox-env.js). Rotates at 5 MB
// keeping one generation, exactly as the query log does. Kill switch: MEMORY_RECALL_CANARY=0.

import { existsSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { renameWithRetry } from './fs-retry.js';
import { join, dirname } from 'node:path';
import { ownStoreDir } from './config.js';
import { indexHeaderOnDisk } from './index-store.js';
import { statSourceFiles } from './freshness.js';
import { redact } from './secrets.js';

/** OFF is explicit. Anything else — unset included — is on. */
export function canaryEnabled() {
  const v = process.env.MEMORY_RECALL_CANARY;
  return v !== '0' && v !== 'false';
}

export function canaryLogPath() {
  if (process.env.MEMORY_RECALL_CANARY_LOG) return process.env.MEMORY_RECALL_CANARY_LOG;
  const store = ownStoreDir();
  return store ? join(store, '.recall-canary.jsonl') : null;
}

export function canaryStatePath() {
  if (process.env.MEMORY_RECALL_CANARY_STATE) return process.env.MEMORY_RECALL_CANARY_STATE;
  const store = ownStoreDir();
  return store ? join(store, '.recall-canary-state.json') : null;
}

// ---- the log -------------------------------------------------------------
// Mirrors logQuery (lib/search.js ~:715-737): append, roll at a cap, keep ONE generation. A
// monitoring log that grows without bound becomes the thing being monitored.
// Read per call, not at import: the suite drives rotation by lowering the cap on a live module.
const logMaxBytes = () => Number(process.env.MEMORY_RECALL_CANARY_MAX_BYTES || 5 * 1024 * 1024);

/** Alarms are shouted ONCE per process per reason+file, so a stuck condition is not a stuck siren. */
const SHOUTED = new Set();

/**
 * Append one row. Returns the path written, or null if nothing was written.
 * Never throws: the callers are a capture timer and a live server.
 */
export function appendCanary(row) {
  if (!canaryEnabled()) return null;
  const path = canaryLogPath();
  if (!path) return null;
  try {
    try {
      // See lib/fs-retry.js: a Windows rotate fails while any process holds either path open, and
      // this log is read by the canary, the walker and every ingest.
      if (statSync(path).size > logMaxBytes()) renameWithRetry(path, path.replace(/\.jsonl$/, '.1.jsonl'));
    } catch { /* no file yet, or another writer won the roll — either way, append */ }
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* already there */ }
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...row }) + '\n', 'utf8');
    if (row.kind === 'alarm') {
      const key = `${row.reason}:${row.file || ''}`;
      if (!SHOUTED.has(key)) {
        SHOUTED.add(key);
        console.error(`[recall-canary] ALARM ${row.reason}: ${JSON.stringify(row).slice(0, 400)}`);
      }
    }
    return path;
  } catch { return null; }
}

/** Test seam only: forget which alarms have already been shouted in this process. */
export function _resetCanaryAlarmsForTests() { SHOUTED.clear(); }

// ---- (a) LAG: how long does a written file stay invisible? ----------------
//
// 🟥 THE HEURISTIC, AND WHERE IT IS WRONG. The 4 KB header carries `sourceListing:{count,digest}`
// — a DIGEST over the file set, not the names — so it cannot answer "is THIS file in the index?".
// What it can answer is "was the index built after this file was written?", and that is what is
// used here: a file whose mtime is <= the header's `builtAt` is treated as visible.
//
// That is a sound UPPER BOUND on lag and an unsound proof of membership. It is wrong in three
// specific ways, all in the direction of UNDER-reporting, which is the safe direction for an
// instrument whose alarm is "this took too long":
//   1. a file written WHILE a build was running has an mtime before `builtAt` and is not in the
//      index — this reports it visible one tick early;
//   2. a file the indexer REFUSED (denylisted name, `metadata.secret`) will never be in the index,
//      and this reports it visible as soon as any later build finishes;
//   3. a build that failed after writing its header would look like a success.
// The precise question needs the doc list, i.e. parsing 130 MB, which is the cost this whole
// module exists to avoid. The honesty probe in the server (below) is the exact instrument; this is
// the cheap one, and it is labelled `basis:'builtAt'` in every row so a reader knows which it is.
//
// `count` from the header IS used, as a second opinion: when the live file count exceeds the
// count the index was built from, at least that many files are certainly missing, and that number
// rides along as `certainlyMissing`.

const DEFAULT_WATCH = 20;
const STATE_MAX_FILES = 500;      // the state file is a memo, not an archive

function readState(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return j && typeof j === 'object' && j.reported && typeof j.reported === 'object' ? j : null;
  } catch { return null; }        // a torn state file is a missing state file: re-seed, do not report
}

function writeState(path, state) {
  if (!path) return;
  try {
    const entries = Object.entries(state.reported);
    if (entries.length > STATE_MAX_FILES) {
      entries.sort((a, b) => (b[1]?.writtenAtMs || 0) - (a[1]?.writtenAtMs || 0));
      state = { ...state, reported: Object.fromEntries(entries.slice(0, STATE_MAX_FILES)) };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state) + '\n', 'utf8');
  } catch { /* an unwritable state file costs a duplicate row, not a failed tick */ }
}

/**
 * One lag observation over the newest store files.
 *
 * STATEFUL BY DESIGN: each file logs its lag exactly ONCE, and "once" has to survive process exit
 * because the observer is a 5-minute timer that is a new process every time. The state file is the
 * memo. On its FIRST run there is no memo, so every currently-visible file would emit a row whose
 * `lagSec` is the distance between an old file and a recent build — meaningless numbers, hundreds
 * of them. So the first run SEEDS and reports nothing; that is the "no log spam" control.
 *
 * @returns {{rows, seeded, watched, visible, pending, costMs, indexBuiltAt, certainlyMissing}}
 */
export function lagObservation({
  storeRoots, stagingIndexPath, now = Date.now(), maxFiles = DEFAULT_WATCH,
  statePath = canaryStatePath(), persist = true
} = {}) {
  const t0 = Date.now();
  const header = stagingIndexPath ? indexHeaderOnDisk(stagingIndexPath) : null;
  const builtAt = header && typeof header.builtAt === 'string' ? header.builtAt : null;
  const builtAtMs = builtAt ? Date.parse(builtAt) : NaN;

  // statSourceFiles takes a ROOT LIST (its cache key maps over it); listCorpusFiles would accept a
  // bare directory string, so normalise here rather than let a plain path throw inside a monitor.
  const roots = typeof storeRoots === 'string'
    ? [{ dir: storeRoots, label: null }]
    : (Array.isArray(storeRoots) ? storeRoots : []);
  const pass = statSourceFiles(roots, { ttlMs: 0 });
  const newest = [...pass.files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);

  const headerCount = Number(header?.sourceListing?.count);
  const certainlyMissing = Number.isFinite(headerCount) ? Math.max(0, pass.count - headerCount) : null;

  const prior = readState(statePath);
  const seeded = prior === null;
  const reported = { ...(prior?.reported || {}) };

  // FORGET FIRST, THEN REPORT. A file that is written, indexed, and then REWRITTEN (the extractor
  // replaces an in-flight exchange with its finished version) has a second lag worth measuring, and
  // the memo is what would silence it. Dropping stale memos BEFORE the emit loop is why the second
  // write reports on the tick it becomes visible rather than the one after.
  for (const f of newest) {
    const memo = reported[f.fileId];
    if (memo && memo.writtenAtMs !== f.mtimeMs) delete reported[f.fileId];
  }

  const rows = [];
  let visible = 0, pending = 0;
  for (const f of newest) {
    const isVisible = Number.isFinite(builtAtMs) && f.mtimeMs <= builtAtMs;
    if (isVisible) visible++; else { pending++; continue; }
    if (reported[f.fileId]) continue;                     // already logged its lag once
    reported[f.fileId] = { writtenAtMs: f.mtimeMs, visibleAtMs: builtAtMs };
    if (seeded) continue;                                 // first run: remember, say nothing
    rows.push({
      kind: 'lag', file: f.fileId,
      writtenAt: new Date(f.mtimeMs).toISOString(),
      visibleAt: builtAt,
      lagSec: Math.max(0, Math.round((builtAtMs - f.mtimeMs) / 1000)),
      basis: 'builtAt'
    });
  }

  // MEMORY_RECALL_CANARY=0 must switch off the whole canary, the state file included: a sidecar
  // written by a disabled feature is how a kill switch turns out to be decorative (test-G, 3d).
  if (persist && canaryEnabled()) writeState(statePath, { at: new Date(now).toISOString(), reported });
  return {
    rows, seeded, watched: newest.length, visible, pending,
    storeFiles: pass.count, indexBuiltAt: builtAt, certainlyMissing,
    costMs: Date.now() - t0
  };
}

// ---- (b) HONESTY: when a file IS invisible, does the answer say so? -------

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'always', 'another', 'because', 'before', 'being',
  'between', 'change', 'claude', 'could', 'daniel', 'different', 'during', 'everything',
  'having', 'however', 'itself', 'nothing', 'number', 'other', 'people', 'please', 'really',
  'should', 'simply', 'something', 'still', 'system', 'their', 'there', 'these', 'thing', 'things',
  'those', 'through', 'together', 'under', 'until', 'using', 'water', 'where', 'which', 'while',
  'without', 'would', 'assistant', 'message', 'session', 'exchange', 'content', 'without',
  'answer', 'question', 'result', 'return', 'string', 'value', 'files', 'file', 'index', 'memory'
]);

/**
 * A rare-looking token from a body, to ask a question only THIS file can answer.
 *
 * Requirements that are not obvious:
 *   - ≥ 6 characters, because `latest`'s own tokenizer is /[a-z0-9][a-z0-9._-]{2,}/ and a shorter
 *     pick would survive here and be dropped there — the probe would then be asking a DIFFERENT
 *     question from the one it scores;
 *   - identifier-shaped preferred (a hyphen, underscore, dot or digit), because those are the
 *     tokens a corpus of engineering exchanges does not repeat by accident;
 *   - RAREST WINS inside the file, as a proxy for rare in the corpus. It is only a proxy: a token
 *     used once here may be common elsewhere, and then the probe's PRESENT verdict is weaker than
 *     it looks. The verdict that matters (DISHONEST) does not depend on rarity at all.
 *   - it must survive redaction. The token becomes a `q` in the query log, so a credential-shaped
 *     token picked out of a body would be written there by the monitor itself. This used to be the
 *     ONLY thing standing between such a token and the log, because logQuery wrote `q` before its
 *     callers guarded it; logQuery now redacts the row itself (B-2), so this filter is a second
 *     line rather than the only one. It is still needed: it also keeps the token out of the CANARY
 *     log, which no guard covers.
 *   - and it is not enough on its own: it skips CREDENTIAL-shaped tokens, not secret CONTENT. A
 *     codename in a denylisted or `metadata.secret` file is neither, which is why the caller
 *     (lib/heartbeat.js recallProbeOnce) must apply exclusionReason BEFORE reaching this function.
 *
 * @returns {string|null} null when the body offers nothing usable — the probe then records N/A.
 */
export function pickToken(body) {
  const text = String(body || '').toLowerCase();
  if (!text) return null;
  // Skip YAML frontmatter: its keys and ids are the same in every file, so a token from there
  // identifies the format, not the exchange.
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  const hay = m ? text.slice(m[0].length) : text;
  const counts = new Map();
  for (const raw of hay.match(/[a-z0-9][a-z0-9._-]{5,}/g) || []) {
    // The character class is `latest`'s own, and it is greedy at the end: "spindle." and "spindle"
    // are different tokens, and a trailing stop is punctuation, not part of the word. Trim it —
    // then re-check the length, because trimming can take a survivor below the bound.
    const tok = raw.replace(/[.\-_]+$/, '');
    if (tok.length < 6) continue;
    if (STOPWORDS.has(tok)) continue;
    if (/^\d[\d.]*$/.test(tok)) continue;                 // a bare number is not a subject
    if (tok.length > 40) continue;                        // a hash or a path fragment, not a word
    counts.set(tok, (counts.get(tok) || 0) + 1);
  }
  if (!counts.size) return null;
  const shaped = (t) => (/[-_.\d]/.test(t) ? 1 : 0);
  const ranked = [...counts.entries()].sort((a, b) =>
    (a[1] - b[1]) || (shaped(b[0]) - shaped(a[0])) || (b[0].length - a[0].length) || a[0].localeCompare(b[0]));
  for (const [tok] of ranked) {
    if (redact(tok).text === tok) return tok;             // never let the monitor log a credential
  }
  return null;
}

/**
 * Did this response tell the truth about a file it has not indexed?
 *
 * `expected` is `{name, token}` — the store file the canary knows is unindexed, and the token it
 * asked about. Pure: it reads a response object and nothing else.
 *
 *   HONEST-PRESENT  the file is IN the answer (WP1's direct read did its job).
 *   HONEST-NAMED    the file is not in the answer, and the answer says so by name, or says plainly
 *                   that it did not read everything (`unindexedChecked.disabled` / `.truncated`).
 *   DISHONEST       the answer made a claim — rows, or "no document mentions every term" — and
 *                   named nothing. This is the only verdict that pages.
 *   N/A             there is nothing unindexed to be honest about, or the answer made no claim.
 */
export function honestyVerdict(response, expected) {
  return honestyEvidence(response, expected).verdict;
}

/** The same judgement, with the sentence that justifies it. */
export function honestyEvidence(response, expected) {
  const r = response || {};
  const name = expected?.name || null;
  if (!name) return { verdict: 'N/A', why: 'nothing was unindexed at probe time' };
  const token = expected?.token ? String(expected.token).toLowerCase() : null;
  const base = (s) => String(s || '').split('/').pop();
  const same = (s) => s && (s === name || base(s) === base(name));

  // --- PRESENT ---------------------------------------------------------
  const rows = Array.isArray(r.results) ? r.results : [];
  for (const row of rows) {
    if (same(row?.name) || same(row?.file)) return { verdict: 'HONEST-PRESENT', why: `results names ${row.name || row.file}` };
    if (token && String(row?.snippet || '').toLowerCase().includes(token)) {
      return { verdict: 'HONEST-PRESENT', why: `a snippet carries "${token}"` };
    }
  }

  // --- NAMED -----------------------------------------------------------
  const named = [];
  for (const f of r.recencyVoid?.unreadFiles || []) if (same(f)) named.push('recencyVoid.unreadFiles');
  for (const list of Object.values(r.foundInUnindexed || {})) {
    for (const f of list || []) if (same(f)) named.push('foundInUnindexed');
  }
  for (const f of r.recentUnindexed?.files || []) if (same(f?.name) || same(f?.file)) named.push('recentUnindexed.files');
  for (const f of r.staleFilesAdded || []) if (same(f)) named.push('staleFilesAdded');
  for (const f of r.staleFilesChanged || []) if (same(f)) named.push('staleFilesChanged');
  if (named.length) return { verdict: 'HONEST-NAMED', why: named.join(', ') };
  // Not by name, but by an admission that the check did not cover everything. Both of these are
  // the response saying "I did not read this", which is the property being measured.
  if (r.unindexedChecked?.disabled) return { verdict: 'HONEST-NAMED', why: `unindexedChecked.disabled=${r.unindexedChecked.disabled}` };
  if (r.unindexedChecked?.truncated) return { verdict: 'HONEST-NAMED', why: 'unindexedChecked.truncated' };
  if (r.scanTruncated) return { verdict: 'HONEST-NAMED', why: 'scanTruncated' };

  // --- DISHONEST -------------------------------------------------------
  if (rows.length) return { verdict: 'DISHONEST', why: `${rows.length} row(s) returned and the unindexed file is named nowhere` };
  const note = String(r.note || '');
  if (/No document (in any corpus )?mentions every term|no index for this scope/i.test(note) || r.noStrongMatch === true) {
    return { verdict: 'DISHONEST', why: `an absence was asserted ("${note.slice(0, 60)}") and the unindexed file is named nowhere` };
  }
  return { verdict: 'N/A', why: 'the response asserted neither presence nor absence' };
}

/**
 * Write one probe finding: the row itself, plus an ALARM row when the verdict is DISHONEST.
 *
 * 🟥 WHY THIS IS A FUNCTION AND NOT FOUR LINES IN THE PROBE. The alarm is the only output of this
 * whole module anyone will ever act on, and — measured, see the WP8 report — the shipped read path
 * cannot be driven to DISHONEST from outside: with the direct read ON the unindexed file is served
 * (HONEST-PRESENT), with it OFF the response names the file through foundInUnindexed /
 * staleFilesAdded / unindexedChecked.disabled (HONEST-NAMED). That is the good news and the
 * problem: an end-to-end fixture cannot reach the branch, so the branch could rot untested while
 * every green run reported peace. Faking it with a seam in the probe was the alternative and is
 * against the rules of this repo. Making it a real unit is not a seam — it is the boundary
 * "decide" / "record" that should have been there anyway — and (a77) drives it directly.
 *
 * @returns {{rows: number, alarmed: boolean}}
 */
export function recordProbe(finding) {
  const { verdict, file, token, why, ms } = finding || {};
  let rows = 0;
  if (appendCanary({ kind: 'probe', ...finding })) rows++;
  const alarmed = verdict === 'DISHONEST';
  if (alarmed && appendCanary({ kind: 'alarm', reason: 'dishonest', file, token, why, ms })) rows++;
  return { rows, alarmed };
}
