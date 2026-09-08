// lib/probe-surface.js — Phase 3b: the verdicts come out of the dark.
//
// The pre-registered calibration (test/probe-calibration.json) put 20
// hand-adjudicated claims through the real evaluator and scored 18/20 with
// ZERO false-STALEs, which is the branch of the bar that says: surface the
// verdicts, advisory-only, and turn the nightly sweep on. This module is that
// surfacing and nothing else.
//
// WHY IT LIVES HERE AND NOT IN lib/search.js. The campaign's hardest promise
// is that a probe verdict can never move a result. The cheapest way to keep a
// promise is to make breaking it require a visible act: search() finishes,
// returns, and only THEN does the tool handler hand its response to this
// module. Ranking cannot read what has not been computed yet, and the a57
// structural pin still holds lib/bm25.js, lib/lexical.js and lib/search.js to
// containing no probe identifier at all.
//
// Everything here is additive: result objects gain a `probeVerdict` field,
// the response gains a `probeVerdicts` summary. No result is dropped,
// reordered, rescored, or filtered on a verdict — pinned behaviorally by
// comparing the [name, score] list with a STALE sidecar present and absent.
//
// Kill switch: MEMORY_PROBE_SURFACE=0 goes back to dark (the sweep keeps
// running; only the surfacing stops).

import { existsSync, statSync } from 'node:fs';
import { readProbeResults } from './probes.js';
import { probeResultsPath } from './config.js';

export function probeSurfaceEnabled() {
  return !['0', 'false', 'off'].includes(String(process.env.MEMORY_PROBE_SURFACE || '').toLowerCase());
}

// The sidecar is small, but search is ~98% of traffic and this must not become
// a file read per query. Keyed on the file's mtime+size, so a fresh sweep is
// picked up immediately and an unchanged sidecar is parsed once.
let CACHE = { key: null, map: null, at: null };
function verdictMap() {
  const path = probeResultsPath();
  if (!path || !existsSync(path)) { CACHE = { key: null, map: null, at: null }; return null; }
  let key;
  try { const st = statSync(path); key = `${st.mtimeMs}:${st.size}`; } catch (_) { return null; }
  if (CACHE.key === key) return CACHE.map;
  const last = readProbeResults();
  if (!last || !Array.isArray(last.results)) { CACHE = { key, map: null, at: null }; return null; }
  const map = new Map();
  for (const r of last.results) if (r && r.name) map.set(r.name, r);
  CACHE = { key, map, at: last.at || null };
  return map;
}

/**
 * The claim a verdict makes, in one sentence, so a reader who has never seen
 * this campaign knows what the word means — especially that UNKNOWN is "could
 * not check", never "stale".
 */
const MEANING = {
  FRESH: 'its recorded probe ran and still matches',
  STALE: 'its recorded probe ran and NO LONGER matches — read the entry with suspicion',
  UNKNOWN: 'the probe could not be checked (error, timeout, refusal, or the level dial) — this is NOT a staleness claim',
  UNPROVABLE: "the claim's anchor is gone (file, database or repo absent), so the probe can no longer even ask"
};

/**
 * Decorate a finished search/latest response IN PLACE-equivalent (a shallow
 * copy) with the sidecar's verdicts. Never throws: a surfacing failure must
 * cost a caller nothing but the annotation.
 */
export function attachProbeVerdicts(res) {
  if (!res || !probeSurfaceEnabled()) return res;
  let map;
  try { map = verdictMap(); } catch (_) { return res; }
  if (!map || !map.size) return res;

  // A name can appear twice (a multi-scope response lists its rows under
  // `groups` AND flattens them into `results`) — the summary counts documents,
  // not appearances.
  const seenMap = new Map();
  // A section result is named `parent#section`; the probe belongs to the
  // parent document, which is the thing that made the claim.
  const decorate = (row) => {
    if (!row || !row.name) return row;
    const hit = map.get(row.name) || map.get(String(row.name).split('#')[0]);
    if (!hit) return row;
    seenMap.set(row.name, hit.verdict);
    return {
      ...row,
      probeVerdict: {
        verdict: hit.verdict,
        probe: hit.probe || null,
        expected: hit.expected ?? null,
        actual: hit.actual ?? null,
        checkedAt: hit.at || null,
        means: MEANING[hit.verdict] || null,
        ...(hit.reason ? { reason: String(hit.reason).slice(0, 200) } : {})
      }
    };
  };

  const out = { ...res };
  if (Array.isArray(out.results)) out.results = out.results.map(decorate);
  if (Array.isArray(out.bestWeak)) out.bestWeak = out.bestWeak.map(decorate);
  // Multi-scope ('all' / 'everything') keeps the rows under `groups.<corpus>`
  // and `results` is only a directory of them — both are decorated so the
  // verdict is wherever the caller happens to be reading.
  if (out.groups && typeof out.groups === 'object' && !Array.isArray(out.groups)) {
    out.groups = Object.fromEntries(Object.entries(out.groups).map(([k, g]) => [k,
      (g && typeof g === 'object')
        ? { ...g,
            ...(Array.isArray(g.results) ? { results: g.results.map(decorate) } : {}),
            ...(Array.isArray(g.bestWeak) ? { bestWeak: g.bestWeak.map(decorate) } : {}) }
        : g]));
  }
  // latest(scope:'all') groups its rows under `sections[]`.
  if (Array.isArray(out.sections)) {
    out.sections = out.sections.map((s) => (s && Array.isArray(s.results) ? { ...s, results: s.results.map(decorate) } : s));
  }
  if (!seenMap.size) return out;

  const seen = [...seenMap].map(([name, verdict]) => ({ name, verdict }));
  const counts = seen.reduce((a, s) => { a[s.verdict] = (a[s.verdict] || 0) + 1; return a; }, {});
  const flagged = seen.filter((s) => s.verdict === 'STALE' || s.verdict === 'UNPROVABLE');
  out.probeVerdicts = {
    checkedAt: CACHE.at,
    counts,
    note: 'ADVISORY ONLY. These verdicts come from the nightly probe sweep sidecar and were ' +
      'attached AFTER ranking finished — no verdict moved, dropped or reordered any result. ' +
      'UNKNOWN means the check could not run; it is never a claim of staleness.' +
      (flagged.length ? ` ${flagged.length} returned ${flagged.length === 1 ? 'entry carries' : 'entries carry'} a ` +
        `non-matching probe: ${flagged.map((f) => `${f.name} (${f.verdict})`).join(', ')}.` : '')
  };
  return out;
}
