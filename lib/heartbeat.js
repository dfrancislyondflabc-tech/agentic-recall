// lib/heartbeat.js — "is the memory connector switched on right now?"
//
// THE PROBLEM THIS SOLVES. Capture runs from a Claude hook, and a hook fires whether or not
// this server is enabled — it has no idea the connector exists. So turning capture on and off
// meant editing hook JSON in your Claude settings, which is a second, invisible switch that
// nobody remembers they set. Meanwhile there is already a switch everyone understands and can
// see: the connector toggle in Claude's own UI.
//
// The two can be joined, because the toggle has a physical consequence: when the connector is
// ON, Claude spawns this process; when it is OFF, it does not. A running server that leaves a
// dated mark on disk therefore IS the toggle, observable from outside by a hook that cannot
// otherwise see Claude's configuration at all.
//
// WHY A HEARTBEAT AND NOT JUST A START MARKER. A file written once at startup goes stale during
// a long session and would read as "switched off" after an hour of work. The mark is refreshed
// on a timer instead, and the timer is unref()'d so it can never be the reason this process
// stays alive.
//
// WHAT IT DELIBERATELY DOES NOT DO: prove the memory TOOL was used. Claude starts every enabled
// server at launch, so the mark says the connector is on — which is the question being asked.
// A session where the tool was never called is still a session you had memory switched on for.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.MEMORY_ROOT ? resolve(process.env.MEMORY_ROOT) : dirname(dirname(fileURLToPath(import.meta.url)));   // see lib/config.js MEMORY_ROOT
const DIR = join(ROOT, ".runtime-cache");
export const HEARTBEAT_PATH = join(DIR, 'connector-heartbeat.json');

/** Default: a mark older than this means the connector is not on. Beats every 60s. */
export const HEARTBEAT_STALE_SEC = 300;

export function beat() {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(HEARTBEAT_PATH, JSON.stringify({
      pid: process.pid,
      lastSeen: new Date().toISOString(),
      lastSeenMs: Date.now()
    }) + '\n', 'utf8');
  } catch {
    // A heartbeat that cannot be written must never take the server down with it. The
    // consequence of failure is that capture falls back to "off", which is the safe direction.
  }
}

/**
 * Start beating, and return a stop function. The interval never holds the process open.
 *
 * The same call also starts the RECALL HONESTY PROBE (see the bottom of this file) on its own,
 * slower interval. They are joined here because they answer the same question from two sides —
 * "is memory actually working right now?" — and because both must be owned by the one process
 * that has the index in RAM. `probeEveryMs: 0` starts the heartbeat alone.
 */
export function startHeartbeat(everyMs = 60_000, { probeEveryMs = PROBE_EVERY_MS } = {}) {
  beat();
  const t = setInterval(beat, everyMs);
  if (typeof t.unref === 'function') t.unref();
  const stopProbe = startRecallProbe(probeEveryMs);
  return () => { clearInterval(t); stopProbe(); };
}

/** Was the connector on within `staleSec`? Absent or unreadable mark = NO. */
export function connectorRecentlyOn(staleSec = HEARTBEAT_STALE_SEC) {
  try {
    const h = JSON.parse(readFileSync(HEARTBEAT_PATH, 'utf8'));
    const age = (Date.now() - Number(h.lastSeenMs)) / 1000;
    return Number.isFinite(age) && age <= staleSec ? { on: true, ageSec: Math.round(age) } : { on: false, ageSec: Math.round(age) };
  } catch {
    return { on: false, ageSec: null };
  }
}

// ---- THE RECALL HONESTY PROBE -------------------------------------------------------------
//
// WHY IT LIVES HERE, of all places. The question it asks — "there is a file in the store that the
// index has not read; does a query about it tell the truth?" — can only be answered by the process
// that actually answers queries, because the defect being hunted is a CACHE defect. The 2026-09-03
// incident was exactly this: the index on disk was current, and the server was answering from a
// copy it had loaded seven hours earlier. A probe run from a fresh process would have found
// nothing wrong, twice over: it would have loaded the current index, and it would have paid 130 MB
// and ~14 s of RAM to do it.
//
// So it rides the heartbeat. The index is already resident (that is the whole point), the interval
// already exists and is already unref'd, and the added cost when nothing is unindexed is one
// TTL-cached stat pass — see the measurements in the WP8 report.
//
// WHAT IT NEVER DOES: write to the corpus, load a model, spawn anything, or throw. Every failure
// resolves to "no probe this tick". The query it issues is tagged `src:'canary'` through
// withQuerySource (lib/config.js), which is an AsyncLocalStorage scope precisely so a person's
// query interleaving with the probe is not mislabelled.

export const PROBE_EVERY_MS = Number(process.env.MEMORY_RECALL_PROBE_MS || 5 * 60_000);
const PROBE_READ_BYTES = 64 * 1024;

let probeInFlight = false;
let lastProbe = null;        // `${file}:${verdict}` — a stuck condition logs once, not every tick

/**
 * One honesty probe. Returns the row it logged, or null when there was nothing to ask about.
 * Exported so the suite can drive it directly instead of waiting five minutes.
 */
export async function recallProbeOnce() {
  if (probeInFlight) return null;
  probeInFlight = true;
  const t0 = Date.now();
  const rss0 = process.memoryUsage.rss();
  try {
    const { canaryEnabled, recordProbe, pickToken, honestyEvidence } = await import('./recall-canary.js');
    if (!canaryEnabled()) return null;
    const { getIndex, latest } = await import('./search.js');
    const { checkStaleness } = await import('./freshness.js');
    const { rootsForCorpus, withQuerySource } = await import('./config.js');

    let idx = null;
    try { idx = getIndex({ scope: 'staging' }); } catch { return null; }
    if (!idx?.present) return null;                       // no staging index: nothing to be honest about

    const st = checkStaleness(idx, rootsForCorpus('staging'));
    if (!st.added.length) return null;                    // N/A — the index has read everything added

    // 🟥 THE INDEXER'S GATES ARE THIS PATH'S GATES TOO. This used to take the newest added file,
    // read 64 kB of it and pick a token — with no exclusionReason() call anywhere. So a denylisted
    // filename or a `metadata.secret: true` file had a word lifted OUT of it and written to
    // .recall-canary.jsonl, and then asked as a real `latest` query, which put it in the query log
    // as well. Two files outside the excluded document then held content from inside it.
    // pickToken's own redact() filter is no defence here: it skips CREDENTIAL-shaped tokens, and a
    // codename or a counterparty — precisely what mechanisms 1 and 2 exist to hide — is neither.
    //
    // lib/unindexed.js:124 is the other direct-read path and has always done this; it imports the
    // same two functions from lib/secrets.js so the two cannot drift apart again.
    //
    // NEWEST-FIRST, then WALK: an excluded file must not silence the monitor. The probe steps past
    // it to the next admissible file and records that instead; only when every added file is
    // excluded does it report nothing this tick.
    const { exclusionReason, scrubSections } = await import('./secrets.js');
    const { parseFrontmatter } = await import('./corpus.js');
    const { basename } = await import('node:path');

    const ordered = st.added
      .map((id) => ({ id, m: st.mtimeById?.get(id) }))
      .filter((x) => Number.isFinite(x.m))
      .sort((a, b) => b.m - a.m);

    let file = null, mtime = -1, token = null;
    for (const cand of ordered) {
      const p = st.pathById?.get(cand.id);
      if (!p) continue;
      let raw = '';
      try { raw = readFileSync(p, 'utf8').slice(0, PROBE_READ_BYTES); } catch { continue; }
      const { front, body: rawBody } = parseFrontmatter(raw);
      if (exclusionReason(basename(p), front)) continue;  // the indexer refuses it; so do we
      // Mechanism 3 as well: a scrubbed section's words may not become the monitor's question.
      const { text: body } = scrubSections(basename(p), rawBody);
      const t = pickToken(body);
      if (!t) continue;                                   // nothing rare enough to ask about
      file = cand.id; mtime = cand.m; token = t;
      break;
    }
    if (!file || !token) return null;

    const res = await withQuerySource('canary', () => latest(token, { scope: 'staging', limit: 5 }));
    const { verdict, why } = honestyEvidence(res, { name: file, token });

    // A stuck stale file would otherwise write the same verdict every five minutes forever.
    const key = `${file}:${verdict}`;
    if (key === lastProbe && verdict !== 'DISHONEST') return null;
    lastProbe = key;

    const row = {
      kind: 'probe', file, token, verdict, why,
      indexBuiltAt: st.indexBuiltAt, unindexedAdded: st.added.length,
      writtenAt: new Date(mtime).toISOString(),
      ...(res?.unindexedChecked ? { unindexedChecked: res.unindexedChecked } : {}),
      results: Array.isArray(res?.results) ? res.results.length : 0,
      ms: Date.now() - t0,
      rssDeltaKb: Math.round((process.memoryUsage.rss() - rss0) / 1024)
    };
    recordProbe(row);          // writes the row, and the alarm row when the verdict is DISHONEST
    return row;
  } catch {
    return null;                                          // a monitor must never take its host down
  } finally {
    probeInFlight = false;
  }
}

/** Start probing. Returns a stop function. The interval never holds the process open. */
export function startRecallProbe(everyMs = PROBE_EVERY_MS) {
  if (!(everyMs > 0)) return () => {};
  // Deliberately NOT run at startup: boot already pays for the index load, and a probe there would
  // measure the load, not the pipeline.
  const t = setInterval(() => { recallProbeOnce().catch(() => {}); }, everyMs);
  if (typeof t.unref === 'function') t.unref();
  return () => clearInterval(t);
}
