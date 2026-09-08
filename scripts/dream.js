#!/usr/bin/env node
// scripts/dream.js — the consolidation pass, as a WORK QUEUE rather than a
// rewrite. Nothing here needs a model; it decides WHAT deserves attention and
// performs only the reversible half itself.
//
//   node scripts/dream.js [--apply] [--force] [--limit N]
//
// Default is a dry report. --apply performs ONLY the two mechanical, reversible
// operations (stamp curatedHash, demote a superseded doc). It never deletes,
// never edits a body, and never removes a credential on its own.
//
// ── THE GATE ───────────────────────────────────────────────────────────────
// Conjunctive, not periodic: fire on ACCUMULATED SIGNAL, not the clock, so a
// quiet week costs nothing and a busy day is not consolidated five times.
// (Shape borrowed from Claude Code's own dream consolidation, which gates on
// minHours AND minSessions. The constants there suit a small hand-written
// corpus; auto-ingest grows orders of magnitude faster, so ours are settings
// and the right values should be MEASURED the way the retrieval constants were,
// not inherited.)
//
// ── WHY A QUEUE AND NOT A REWRITE ──────────────────────────────────────────
// Measured 2026-08-17: rewriting all 101 descriptions by hand is worth about
// two rank-1 positions. Curation is low-yield PER DOCUMENT, so a pass that
// walks the corpus spends nearly all of its effort on memories nobody ever
// retrieves. The query log (lib/search.js logQuery) is what makes the
// difference: it says which documents are actually being asked for, and which
// of those are ranking badly. That is the only defensible way to aim a pass
// that costs tokens.
//
// ── SUPERSESSION, WHICH IS THE PART WORTH HAVING ───────────────────────────
// A correction and a changed fact look identical in text, and embeddings encode
// topic rather than truth-direction: "30+ agents caused it" and "5 agents, never
// more than 2" are NEAR NEIGHBOURS, not opposites. So detection here is
// retrieval-based and deliberately advisory — a staged exchange whose nearest
// neighbour is an OLDER document on the same subject is a CANDIDATE, queued for
// a human or a model to adjudicate. It is never auto-resolved.
// When it is resolved, the loser is DEMOTED, not deleted: `supersededBy` in
// frontmatter and archive tier, so search returns the current fact while
// neighbors can still reach the superseded one. Destructive overwrite loses
// that history; this does not.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus } from '../lib/corpus.js';
import { search } from '../lib/search.js';
import { redact } from '../lib/secrets.js';
import { ownStoreDir, queryLogPath, memoryRoots } from '../lib/config.js';

// DREAM NEVER SEES THE LIBRARY. loadCorpus() with no argument is EVERY root,
// and the library roots joined memoryRoots() for get/tier to work — but dream
// is the curation pass: secret-review, name-collision, supersession,
// write-description queues. A 300-chapter book in those queues is all noise
// (its "secrets" are fiction, its descriptions are headings, its corrections
// are dialogue), and its files are read-only anyway. Work roots only.
const workRoots = () => memoryRoots().filter((r) => r.docType !== 'library-doc');

const APPLY = process.argv.includes('--apply');
// --accept-secrets <file,file>  record a keep+index decision against current hashes
// --shadow-all  evaluate the supersession arm over EVERY staged document, not
// just the uncurated ones. Dream is incremental by design, so once --apply has
// stamped the corpus the arm sees almost nothing: a shadow run reported "0 of 10
// pass" while actually looking at 43 documents out of 2,027. An arm being
// evaluated has to be measured on the whole population or the zero means
// nothing. Shadow only -- this never queues.
const SHADOW_ALL = process.argv.includes('--shadow-all');
const ACCEPT = (() => { const i = process.argv.indexOf('--accept-secrets'); return i === -1 ? [] : String(process.argv[i + 1] || '').split(',').filter(Boolean); })();
const FORCE = process.argv.includes('--force');

// ── --if-due : the daily heartbeat ──────────────────────────────────────────
//
// Dream was scheduled NOWHERE. Verified 2026-08-25: zero crontab entries, zero
// launch agents, zero Claude hooks referenced this file, so the curation layer only
// ever ran when somebody typed the command — which is why the supersession arm has
// never accumulated enough evidence to judge. The arm was not silent; it was never
// asked.
//
// The normal gate is `minHours AND minNewDocs`, which on a quiet week never opens.
// --if-due is TIME-ONLY: has a day passed? If not, exit 0 immediately and quietly,
// which makes it cheap enough to call from the Stop hook after every turn. The
// guard lives HERE, not in the hook, so it travels with the script — a hook
// carrying its own idea of "due" would drift from this one.
const IF_DUE = process.argv.includes('--if-due');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i === -1 ? 40 : parseInt(process.argv[i + 1]) || 40; })();

const GATE = { minHours: Number(process.env.DREAM_MIN_HOURS ?? 24), minNewDocs: Number(process.env.DREAM_MIN_NEW_DOCS ?? 25) };
const statePath = () => join(ownStoreDir() || '.', '.dream-state.json');
const readState = () => { try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return { lastRun: null, curated: {} }; } };
const writeState = (s) => { mkdirSync(ownStoreDir(), { recursive: true }); writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n', 'utf8'); };

const state = readState();

// THE DUE CHECK RUNS FIRST, BEFORE ANY LOADING.
//
// It was originally placed next to the other gate logic, which sits after
// loadCorpus() and after the embedding model warms — so `--if-due` on a NOT-due
// day took 3 minutes 28 seconds to decide it had nothing to do. From a Stop hook
// that fires after every turn, that is unusable. Reading one small JSON file and
// exiting costs milliseconds.
if (IF_DUE) {
  const h = state.lastRun ? (Date.now() - Date.parse(state.lastRun)) / 36e5 : Infinity;
  if (h < GATE.minHours) {
    console.log(`not due (${h.toFixed(1)}h since last run, need ${GATE.minHours}h)`);
    process.exit(0);
  }
}

const { docs } = loadCorpus(workRoots());

// ---- 1. what has this pass never seen? (hash-skip) ------------------------
// Every doc already carries a sha256 of its raw bytes, the same field the
// indexer uses to reuse vectors. Stamping it on curation makes the pass
// incremental for free — and an EDITED memory changes hash, so it re-queues
// itself. No bookkeeping, no reprocessing.
//
// STAMPS NOW CARRY WHEN THEY WERE MADE. state.curated[file] used to be the
// bare hash, which is why the supersession arm gathered ZERO shadow rows in
// three days of daily runs: the arm scored UNCURATED docs only, and after the
// first --apply everything was stamped forever. A stamp is now {hash, at};
// legacy bare-hash stamps read as at=0 (immediately window-eligible), so the
// backlog rolls through at LIMIT per day and re-stamps itself as it goes.
const stampHash = (e) => (typeof e === 'string' ? e : e?.hash);
const stampAt = (e) => (typeof e === 'string' ? 0 : (Date.parse(e?.at) || 0));
const uncurated = docs.filter((d) => stampHash(state.curated[d.file]) !== d.hash);

// The ROLLING RE-SCORE WINDOW: stamped docs whose stamp is older than
// DREAM_RESCORE_DAYS re-enter the supersession arm's pool (and only that pool
// — secrets/collisions/descriptions stay hash-incremental, their findings do
// not decay). This is what lets the arm actually ACCUMULATE the evidence it
// was scheduled to gather.
const RESCORE_DAYS = Number(process.env.DREAM_RESCORE_DAYS ?? 7);
const rescoreCutoff = Date.now() - RESCORE_DAYS * 864e5;
const rescoreWindow = docs.filter((d) =>
  stampHash(state.curated[d.file]) === d.hash && stampAt(state.curated[d.file]) < rescoreCutoff);

const hoursSince = state.lastRun ? (Date.now() - Date.parse(state.lastRun)) / 36e5 : Infinity;
// --if-due ignores minNewDocs deliberately: "has a day passed" is the whole
// question, and also requiring 25 changed documents is what kept the daily run
// from ever happening.
const dueByTime = hoursSince >= GATE.minHours;   // already checked above for --if-due
const gateOk = FORCE || (IF_DUE && dueByTime) || (dueByTime && uncurated.length >= GATE.minNewDocs);

console.log(`corpus       : ${docs.length} docs across ${workRoots().length} work root(s) (library categories excluded from curation)`);
console.log(`uncurated    : ${uncurated.length}   (hash differs from last curation)`);
console.log(`last run     : ${state.lastRun || 'never'}  (${hoursSince === Infinity ? 'n/a' : hoursSince.toFixed(1) + 'h ago'})`);
console.log(`gate         : minHours ${GATE.minHours} AND minNewDocs ${GATE.minNewDocs} -> ${gateOk ? 'OPEN' : 'CLOSED'}${FORCE ? ' (forced)' : ''}`);
if (!gateOk) { console.log('\nnothing to do.'); process.exit(0); }

// ---- 2. telemetry: what is actually being retrieved? ----------------------
const retrieved = new Map();     // doc name -> {hits, worstRank, weakHits}
const logPath = queryLogPath();
let queries = 0;
if (logPath && existsSync(logPath)) {
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let q; try { q = JSON.parse(line); } catch { continue; }
    // ONLY REAL CALLS RANK THE QUEUE.
    //
    // The write-description queue below is ORDERED BY `hits`, so counting suite
    // traffic ranked it by whatever the benchmark asks most. Measured before this
    // guard: "MEMORY retrieved 1875x", and an exchange from the very session that
    // was running the tests at "600x" -- 7,953 rows tagged live in one day across
    // just 99 DISTINCT queries. A queue meant to say what NEEDS a description was
    // reporting what the gold set happens to hit.
    //
    // Rows predating src tagging are `undefined` and are still counted: dropping
    // years of history to fix one day of noise trades one wrong number for another.
    if (q.src === 'test' || q.src === 'unknown') continue;
    queries++;
    (q.top || []).forEach((t, i) => {
      if (!t?.name) return;
      const r = retrieved.get(t.name) || { hits: 0, worstRank: 0, weakHits: 0 };
      r.hits++; r.worstRank = Math.max(r.worstRank, i + 1);
      if (q.noStrongMatch) r.weakHits++;
      retrieved.set(t.name, r);
    });
  }
}
console.log(`telemetry    : ${queries} logged queries (live + pre-tagging), ${retrieved.size} distinct documents ever returned`);

// THE FEEDBACK LOOP. Everything this server tells a caller is static text — it
// advertises a capability and never learns whether anyone followed it. The query
// log is the only thing that can say, and nothing ever surfaced it. dream runs
// daily now, so dream carries the headline.
try {
  const { queryLogSummary } = await import('./analyse-query-log.js');
  const sum = queryLogSummary();
  if (sum) { console.log(''); for (const l of sum.lines) console.log(l); }
} catch (e) {
  console.log(`telemetry    : (query-log summary unavailable: ${String(e.message || e).slice(0, 60)})`);
}

// THE ORPHAN-HANDOFF ALARM RIDES THE SAME HEADLINE, for the same reason the
// query-log summary does: dream is what actually runs. A handoff document one
// level below a configured root matches the patterns and is indexed by nothing
// (the scan is flat by design — lib/config.js), and search only mentions it to
// whoever queries the handoff scope. The daily run says it to whoever reads
// the report, which is how three of these sat invisible for days.
try {
  const { orphanHandoffs } = await import('../lib/orphan-handoffs.js');
  const orphans = orphanHandoffs({ force: true });
  if (orphans.length) {
    console.log(`\nORPHAN HANDOFFS: ${orphans.length} file(s) match the handoff patterns one level BELOW a configured root — unindexed, unreachable:`);
    for (const p of orphans) console.log(`  ${p}\n    -> move it into the root, or add its directory to MEMORY_HANDOFF_DIRS / DEFAULT_HANDOFF_DIRS`);
  }
} catch (_) { /* the alarm must never fail a dream run */ }

// ---- 3. the queue ---------------------------------------------------------
const queue = [];

// (a) SECRETS — ASK, never act. A credential the user WANTS remembered is a
// legitimate memory; the corpus already has the state for it (denylisted file:
// kept on disk in full, never indexed, get() refuses). So the only correct move
// is to present it and let a human choose index / exclude. Never delete.
// A credential the user has decided to KEEP is not a finding any more. The
// decision is recorded against the file's CONTENT HASH, so it stands while the
// file is unchanged and re-opens the moment the file gains something new —
// accepting "this memory may hold credentials" forever would be a standing
// blind spot. Daniel accepted example-bot and zip-build-checklist-FULL-
// archive on 2026-08-18: both legitimately document credentials he wants kept.
state.acceptedSecrets = state.acceptedSecrets || {};
for (const d of uncurated) {
  const hits = redact(d.body || '').hits;
  if (!hits.length) continue;
  // 2026-08-29: keyed by NAME, not file. Sections of one document are separate docs
  // with separate hashes, so a file-keyed decision was overwritten by the next
  // section of the SAME file: zip-build-checklist-FULL-archive has three flagged
  // sections, and accepting any one of them re-opened the other two. The queue
  // cycled forever and the ruling could never stick — a decision that cannot be
  // recorded is the same defect class as a rule that is not enforced.
  if (state.acceptedSecrets[d.name] === d.hash) continue;      // decided, unchanged
  const reopened = state.acceptedSecrets[d.name] && state.acceptedSecrets[d.name] !== d.hash;
  queue.push({ kind: 'secret-review', file: d.file, name: d.name,
    detail: hits.join(',') + (reopened ? '  [REOPENED: file changed since you accepted it]' : ''),
    action: 'ASK: keep+index, or keep+exclude. never delete.' });
}

// (a2) NAME COLLISIONS. lib/corpus.js WARNs on these, but a warning in a server
// log is not a thing anyone reads. A doc is addressed by name (get, neighbors,
// resolveDoc), so the loser of a collision is simply unreachable — it is in the
// index, it can be RETRIEVED by search, and then get() hands back a different
// document. That is the worst failure shape available: findable but wrong.
// Queue it as work rather than trusting the writer to have qualified its names.
{
  const byName = new Map();
  for (const d of docs) {
    if (!byName.has(d.name)) { byName.set(d.name, d.file); continue; }
    queue.push({ kind: 'name-collision', file: d.file, name: d.name,
      detail: `shadowed by ${byName.get(d.name)}`,
      action: 'RENAME the loser (get()/neighbors can never reach it). never delete.' });
  }
}

// (b) SUPERSESSION — OFF BY DEFAULT, RUNNING IN SHADOW.
//
// MEASURED 2026-08-18 on the real corpus: 20 candidates, ZERO true positives.
// Every one was a correction phrase paired with a memory that never asserted the
// thing being corrected. Two of the twenty touched a memory that DID contain the
// relevant claim, and in both the memory was right and the correction was of
// something I had said — the opposite of a supersession.
//
// The cause is structural, not a tuning miss: SIMILARITY FINDS TOPIC, and a
// correction is about a CLAIM. In a long exchange those come apart constantly —
// "I was wrong" about one thing, dominant topic another, pairing made on topic.
//
// So the arm no longer feeds the queue. It runs in SHADOW: every candidate is
// written to .supersession-shadow.jsonl with its evidence, so the idea can be
// evaluated over real traffic without spending anyone's attention. Precedent is
// this project's own — answer-coverage ships its chain arm OFF because it
// covered 15 confirmed misses.
//
// TURNED ON 2026-08-18, on the evidence below. It shipped OFF and spent its
// time in shadow; the full-corpus evaluation (--shadow-all over 2,027 staged
// exchanges) is what earned it the switch:
//     20 candidates / 0 genuine   -> the version that shipped off
//     24 candidates / 6 genuine   -> first-person retractions only
// Of those six, four are worth a human, one names a memory that already
// records the correction, and one is a containment miss. A modest, known
// error rate on a six-item queue.
// Shadow logging CONTINUES while it is on, so the evidence keeps accruing and
// the decision stays reversible on data rather than memory.
//   DREAM_SUPERSESSION=off     do not compute it at all
//   DREAM_SUPERSESSION=shadow  compute + log, never queue
//   DREAM_SUPERSESSION=on      compute + log + QUEUE            (default)
// Only phrases that assert a PRIOR CLAIM IS WRONG. Measured against the 2,014
// staged exchanges: an earlier, looser list (actually / in fact / rather than /
// instead of) fired on 76% OF EVERY EXCHANGE, because those describe a choice or
// are discourse filler. This one fires on 15%.
// MEASURED TWICE. The first list fired on 76% of every exchange. The second
// still produced 20 candidates and 0 true positives, and the shadow log shows
// why: "is wrong" and "contradicts" attach to THINGS, not to claims — "your
// token is wrong", "the flag is wrong", "the quote is WRONG without sales tax".
// None of those retracts a statement; they assert one.
// A supersession needs someone to withdraw a PRIOR CLAIM, so the phrase must
// bind to a speaker or a statement.
// FIRST-PERSON RETRACTIONS ONLY. Measured over all 2,027 staged exchanges
// (--shadow-all), because the incremental run was scoring 43 documents and its
// zero meant nothing. 38 raw candidates, 13 passed containment, and reading all
// 13 split them cleanly:
//   4  first-person retractions   -- every one a genuine withdrawn claim
//   9  concessions and word-sense -- "you were right to ask", "you were right on
//      both counts, and both are now committed", and "superseded by" describing
//      a FILE that was deleted rather than a claim that was retracted.
// Conceding a point is not withdrawing a claim, so the second-person forms and
// the bare supersede/contradict verbs are gone.
const CORRECTION_RE = /\b(i was wrong|i were wrong|i got .{0,20}wrong|that was wrong|(my|the|that|my earlier|my last) [a-z ]{0,24}(claim|comment|answer|statement|note|advice|reading|assumption)[a-z ]{0,12} was wrong|correction:|i owe you a correction|i misread|i misremembered|i was mistaken|no longer (true|the case|accurate)|scratch that)\b/i;

// ONLY THE ASSISTANT'S HALF. Shadow run: a memory was nominated purely
// because the USER'S question contained "tell me what is wrong with the
// containers". A question is not a correction. The extractor writes
// "**Asked:** <user>" followed by the reply, so the reply is everything after
// that first paragraph.
function assistantHalf(body) {
  const t = String(body || '');
  const i = t.indexOf('**Asked:**');
  if (i === -1) return t;
  const nl = t.indexOf('\n\n', i);
  return nl === -1 ? '' : t.slice(nl + 2);
}

// TWO SHAPES THAT LOOK LIKE CORRECTIONS AND ARE NOT. Both were the last
// survivors of the shadow run, and both are the OPPOSITE of a supersession:
//
//   CONFIRMATION — "I misremembered the path (the memory note says
//   data/emails.db.pre-compact)". The speaker corrected THEMSELVES TOWARD the
//   memory, so the memory was right. Demoting it would delete the one account
//   that held up.
//
//   PREAMBLE — "I owe you a correction — let me check the log before I answer".
//   The correction has been announced, not made. Whatever it turns out to be is
//   in a later sentence, and may not concern this memory at all.
const CONFIRMS_MEMORY_RE = /\b(the )?memor(y|ies)( note| file)? (says|said|does record|records|has|is right|was right)\b|\bmemory does record\b/i;
const PREAMBLE_RE = /\b(let me (check|verify|look|re-?read|confirm)|before I answer|i'll check|going to check)\b/i;

// 🟥 DEFAULT MOVED 'on' -> 'shadow' (2026-09-03). The queued arm's precision is measured at 0/6 over
// its whole life: of the six candidates that ever survived containment, three named memories that
// had ALREADY been corrected and three named memories that never contained the claim (MEM-8, re-
// confirmed over 27 unique candidates / 15 days; 4 new candidates in the last 9 days, 0 queued). The
// standing rule for a judgment feature is precision <50% ⇒ do not act on it, so it computes and logs
// and no longer puts work in front of a human. Containment itself is sound — 21/21 rejections
// spot-check correct — so the evidence keeps accruing for the third condition MEM-8 asks for:
// before queueing, check whether the target STILL asserts the superseded version.
const SUPERSESSION_MODE = (process.env.DREAM_SUPERSESSION || 'shadow').toLowerCase();

// THE TEST THAT WAS MISSING. A supersession requires the older memory to ACTUALLY
// ASSERT the thing that got corrected. Similarity cannot show that; term
// containment can. Take the sentence carrying the correction, strip the
// correction phrase and stopwords, and require the memory body to contain enough
// of what remains.
const _STOP = new Set(('the a an and or but if then than that this these those is are was were be been being have has had do does did will would can could should i you we they it not no yes of in on at to for with from by as so about into over after before your my our their there here what when which who how why me him her them us also just only very more most some any each other same such own too then now well back even still way take get make know think see come want use find give tell work call try ask need feel become leave put mean keep let begin seem help talk turn start show hear play run move like live believe hold bring happen write provide sit stand lose pay meet include continue set learn change lead understand watch follow stop create speak read allow add spend grow open walk win offer remember love consider appear buy wait serve die send expect build stay fall cut reach kill remain').split(' '));
function correctionSentence(text, phrase) {
  const i = text.toLowerCase().indexOf(String(phrase).toLowerCase());
  if (i === -1) return '';
  const start = Math.max(0, text.lastIndexOf('.', i) + 1);
  let end = text.indexOf('.', i + phrase.length);
  if (end === -1) end = Math.min(text.length, i + 260);
  return text.slice(start, Math.min(end + 1, start + 400));
}
function claimTerms(sentence, phrase) {
  const cleaned = sentence.toLowerCase().split(String(phrase).toLowerCase()).join(' ');
  const toks = cleaned.match(/[a-z][a-z0-9_.-]{3,}/g) || [];
  return [...new Set(toks.filter((t) => !_STOP.has(t)))];
}
// The arm's score gate, calibrated on the REAL corpus (0.55). An env knob so
// the suite's tiny fixtures — whose keyword normalisation structurally caps
// scores near 0.52 — can exercise the window end-to-end; the default is
// pinned by test and never moved here.
const SUPERSEDE_MIN_SCORE = Number(process.env.DREAM_SUPERSEDE_MIN_SCORE ?? 0.55);
const CONTAIN_MIN_TERMS = Number(process.env.DREAM_CLAIM_MIN_TERMS ?? 3);
const CONTAIN_MIN_SHARE = Number(process.env.DREAM_CLAIM_MIN_SHARE ?? 0.34);
function memoryAssertsClaim(memoryBody, terms) {
  if (terms.length < CONTAIN_MIN_TERMS) return { ok: false, share: 0, hit: [] };
  const body = String(memoryBody || '').toLowerCase();
  const hit = terms.filter((t) => body.includes(t));
  return { ok: hit.length / terms.length >= CONTAIN_MIN_SHARE && hit.length >= CONTAIN_MIN_TERMS, share: hit.length / terms.length, hit };
}

const shadowRows = [];
const rescored = [];
if (SUPERSESSION_MODE !== 'off') {
  // Uncurated first (new material is the best signal), then the rolling
  // window — LIMIT still caps the run, so a 2,000-doc backlog is a queue,
  // not a stampede.
  const pool = SHADOW_ALL ? docs : [...uncurated, ...rescoreWindow];
  if (rescoreWindow.length) console.log(`  rescore window: ${rescoreWindow.length} stamped doc(s) older than ${RESCORE_DAYS}d re-enter the arm's pool`);
  const staged = pool.filter((d) => d.type === 'exchange' || d.root);
  if (SHADOW_ALL) console.log(`  shadow-all: evaluating ${staged.length} staged documents`);
  const bestByTarget = new Map();
  for (const d of staged.slice(0, LIMIT)) {
    rescored.push(d);          // scored this run — apply refreshes its stamp's `at`
    const text = assistantHalf(d.body);
    const m = text.match(CORRECTION_RE);
    if (!m) continue;
    let res;
    try { res = await search(`${d.description} ${(d.body || '').slice(0, 300)}`, { limit: 3 }); } catch { continue; }
    for (const hit of res.results || []) {
      if (hit.name === d.name) continue;
      if (!(hit.score >= SUPERSEDE_MIN_SCORE && Date.parse(hit.modified) < Date.parse(d.modified))) continue;
      const sent = correctionSentence(text, m[0]);
      if (CONFIRMS_MEMORY_RE.test(sent) || PREAMBLE_RE.test(sent)) break;   // confirmation or announcement, not a retraction
      const terms = claimTerms(sent, m[0]);
      const target = docs.find((x) => x.name === hit.name);
      const contains = memoryAssertsClaim(target?.body, terms);
      const prev = bestByTarget.get(hit.name);
      if (!prev || hit.score > prev.score) {
        bestByTarget.set(hit.name, { doc: d, target: hit.name, score: hit.score, phrase: m[0],
          sentence: sent.replace(/\s+/g, ' ').trim().slice(0, 240), terms, contains,
          days: (Date.parse(d.modified) - Date.parse(hit.modified)) / 864e5 });
      }
      break;
    }
  }
  for (const c of bestByTarget.values()) {
    shadowRows.push({ ts: new Date().toISOString(), from: c.doc.name, target: c.target,
      score: c.score, days: Number(c.days.toFixed(1)), phrase: c.phrase,
      claimTerms: c.terms.slice(0, 12), containShare: Number(c.contains.share.toFixed(2)),
      passesContainment: c.contains.ok, sentence: c.sentence });
    if (SUPERSESSION_MODE === 'on' && c.contains.ok) {
      queue.push({ kind: 'supersession-candidate', file: c.doc.file, name: c.doc.name,
        detail: `may supersede ${c.target} (score ${c.score}, older by ${c.days.toFixed(0)}d, claim-overlap ${(c.contains.share * 100).toFixed(0)}%)`,
        action: 'ADJUDICATE: correction, or a fact that changed? demote the loser, never delete.' });
    }
  }
}

// (c) CURATION targets — telemetry-ranked, which is the whole point.
const targets = uncurated
  .filter((d) => d.descriptionSynthesised || d.type === 'exchange')
  .map((d) => ({ d, t: retrieved.get(d.name) || { hits: 0, worstRank: 0, weakHits: 0 } }))
  .filter((x) => x.t.hits > 0)
  .sort((a, b) => (b.t.hits * b.t.worstRank) - (a.t.hits * a.t.worstRank));
for (const { d, t } of targets.slice(0, LIMIT)) {
  queue.push({ kind: 'write-description', file: d.file, name: d.name,
    detail: `retrieved ${t.hits}x, worst rank ${t.worstRank}${t.weakHits ? `, ${t.weakHits} weak` : ''}`,
    action: 'WRITE a real description; promote to hot if it earned it.' });
}

// ---- 3b. THE NIGHTLY PROBE SWEEP (LIVE since the 3b calibration) -----------
// Probes run from HERE and from the explicit probe_status action — never on
// the query path. Verdicts go to the sidecar only; a sweep failure must never
// fail the dream run, and nothing downstream of this block reads the results.
// The calibration (18/20, 0 false-STALEs) opened the surfacing branch, so what
// this sweep writes is now what search shows — at the DEFAULT level, `cheap`:
// nightly, unattended, on someone's laptop, the local file/git/date predicates
// are the ones that cannot knock on a port or a database while they run.
try {
  const { sweepProbes } = await import('../lib/probes.js');
  const swept = await sweepProbes(docs);
  if (swept.count) {
    console.log(`\nprobes       : ${swept.count} swept at level '${swept.level}' -> ` +
      Object.entries(swept.summary).map(([k, v]) => `${k} ${v}`).join(', ') +
      '   (sidecar only — search reads it, ranking never does)');
  }
} catch (e) {
  console.log(`probes       : sweep failed (${String(e.message || e).slice(0, 80)}) — dream continues`);
}

// ---- 3c. PROPOSED probes — drafted from prose, executed by nobody ----------
// The corpus states checkable facts in sentences all day long (a ship tag
// beside its sha, an endpoint someone curls, a path that must exist) and not
// one of them is checkable, because the sweep reads frontmatter and nothing
// else. This drafts the frontmatter — and stops there. Nothing below runs a
// proposal, and lib/probe-proposals.js cannot: it never imports the evaluator.
// A proposal becomes a probe when a human writes it into the memory.
try {
  const { proposeProbes } = await import('../lib/probe-proposals.js');
  const { configuredRepos } = await import('../lib/git-join.js');
  const { rootsForCorpus } = await import('../lib/config.js');
  const repoCandidates = configuredRepos().map((r) => r.dir);
  // CURATED ONLY. A captured exchange records a moment; a hand-written memory
  // asserts current truth, and only the second kind is worth a probe. Run
  // across all eight work roots this produced 1,660 proposals over 659
  // documents — a queue nobody reads.
  const curatedDirs = rootsForCorpus('curated').map((r) => r.dir);
  const curatedDocs = docs.filter((d) => curatedDirs.some((dir) => String(d.path || '').startsWith(dir + '/')));
  for (const item of proposeProbes(curatedDocs, { repoCandidates })) {
    queue.push({ kind: 'probe-proposal', file: item.file, name: item.name,
      proposals: item.proposals,
      detail: `${item.proposals.length} checkable claim(s) in prose, no probe in frontmatter`,
      action: 'READ the evidence line; if the claim is right, paste the drafted lines into this memory\'s frontmatter. Nothing runs until you do.' });
  }
} catch (e) {
  console.log(`proposals    : extraction failed (${String(e.message || e).slice(0, 80)}) — dream continues`);
}

// ---- 3d. PROTECTED-SET MARGINS ---------------------------------------------
// How much room do the gold answers and the verbatim fixtures have left? A
// 0.005 margin held for weeks and nobody knew until a fixture walked into it
// and the suite went red. One reading per nightly run, with the trend.
// Read-only; a monitor failure must never fail the dream.
try {
  const { measureMargins, previousReading, appendHistory, trendLine } =
    await import('./monitor-margins.js');
  const reading = await measureMargins();
  const prev = previousReading();
  appendHistory(reading);
  console.log(trendLine(reading, prev));
} catch (e) {
  console.log(`margins      : monitor failed (${String(e.message || e).slice(0, 80)}) — dream continues`);
}

// ---- 4. report ------------------------------------------------------------
const byKind = queue.reduce((a, q) => { (a[q.kind] ||= []).push(q); return a; }, {});
if (shadowRows.length) {
  try {
    mkdirSync(ownStoreDir(), { recursive: true });
    const f = join(ownStoreDir(), '.supersession-shadow.jsonl');
    appendFileSync(f, shadowRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch (_) { /* shadow logging must never fail a run */ }
  const pass = shadowRows.filter((r) => r.passesContainment).length;
  console.log(`\nSUPERSESSION [${SUPERSESSION_MODE}]: ${shadowRows.length} raw candidate(s), ${pass} pass the claim-containment test` +
              (SUPERSESSION_MODE === 'on' ? '' : '  (logged, NOT queued)'));
}

// 🟥 PERSIST THE QUEUE BEFORE PRINTING IT.
//
// This script runs from the Stop hook as `dream.js --if-due 2>/dev/null || true`: stderr is
// explicitly discarded and stdout is inherited by a hook host that keeps no file. So everything
// below — every proposal, every candidate, the queue length itself — was written to a console
// nobody would ever read. MEM-23 put it exactly: the circulating "19 proposals await review"
// described a queue that did not exist.
//
// Two sinks, because they answer two different questions:
//   .dream-queue.json   what is waiting RIGHT NOW (overwritten each run, so it cannot go stale)
//   .dream-runs.jsonl   what this has been doing over time (append-only, one line per run)
//
// The snapshot carries the items themselves, bounded, so a reader can act on it without re-running
// anything. Fail-open: a sink that cannot be written must never break the nightly run.
try {
  const dir = ownStoreDir();
  mkdirSync(dir, { recursive: true });
  // Its own timestamp: `nowIso` is declared further down the file, so reading it here threw a
  // ReferenceError — which the catch below swallowed, leaving NO sink and NO error. That is the
  // exact failure this change exists to remove, reproduced inside the fix for it. Hence also the
  // console.error in the catch: a sink that fails silently is the same bug again.
  const sinkAt = new Date().toISOString();
  const summary = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length]));
  writeFileSync(join(dir, '.dream-queue.json'), JSON.stringify({
    at: sinkAt,
    queued: queue.length,
    byKind: summary,
    items: queue.slice(0, 200).map((q) => ({
      kind: q.kind, file: q.file, name: q.name,
      // proposals are the actionable part; keep a few per item rather than all of them
      proposals: Array.isArray(q.proposals) ? q.proposals.slice(0, 5) : undefined,
      why: q.why || q.reason || undefined
    }))
  }, null, 2) + '\n', 'utf8');
  appendFileSync(join(dir, '.dream-runs.jsonl'), JSON.stringify({
    at: sinkAt,
    trigger: IF_DUE ? 'hook' : 'manual',
    corpusDocs: docs.length,
    uncurated: uncurated.length,
    hoursSinceLastRun: hoursSince === Infinity ? null : Number(hoursSince.toFixed(2)),
    queued: queue.length,
    byKind: summary
  }) + '\n', 'utf8');
} catch (e) {
  // Fail-open on the RUN, loud on the SINK. Swallowing this silently is how the first version of
  // this very block shipped broken.
  console.error('[dream] could not write the queue sinks: ' + String(e && e.message || e).slice(0, 200));
}


console.log(`\n=== WORK QUEUE: ${queue.length} item(s) ===`);
for (const [kind, items] of Object.entries(byKind)) {
  console.log(`\n[${kind}]  ${items.length}`);
  // A proposal is only useful if the reader can see BOTH the sentence that
  // produced it and the exact lines to paste. Printing a one-line summary
  // would make it a chore to act on, and an unactionable proposal is worse
  // than none: it teaches the reader to skip the section.
  if (kind === 'probe-proposal') {
    const total = items.reduce((a, it) => a + it.proposals.length, 0);
    console.log(`   ${total} drafted probe(s) across ${items.length} memor${items.length === 1 ? 'y' : 'ies'} — DRAFTS ONLY, nothing has run.`);
    for (const it of items.slice(0, 8)) {
      console.log(`\n   ${it.name}`);
      for (const p of it.proposals.slice(0, 3)) {
        console.log(`      evidence: ${p.evidence}`);
        console.log(`      why     : ${p.why}`);
        if (p.hazard) console.log(`      HAZARD  : ${p.hazard}`);
        console.log(`      paste   : probe: ${p.probe}`);
        console.log(`                probe_expected: ${p.probe_expected}` +
          (p.level === 'all' ? '        (needs MEMORY_PROBE_LEVEL=all)' : ''));
        if (p.repoCandidates && p.repoCandidates.length > 1) {
          console.log(`                repo slot is a GUESS — candidates: ${p.repoCandidates.join(' | ')}`);
        }
      }
      if (it.proposals.length > 3) console.log(`      … ${it.proposals.length - 3} more in this memory`);
    }
    if (items.length > 8) console.log(`\n   … ${items.length - 8} more memories with proposals`);
    continue;
  }
  for (const it of items.slice(0, 12)) console.log(`   ${it.name.padEnd(26)} ${it.detail}\n      -> ${it.action}`);
  if (items.length > 12) console.log(`   … ${items.length - 12} more`);
}
if (!queue.length) console.log('  (nothing needs attention — uncurated docs exist but none is retrieved, secret-bearing, or a supersession candidate)');

if (!APPLY) {
  // A dry --if-due pass MUST still record that it ran, or the Stop hook re-runs it
  // on every single turn for the rest of the day.
  if (IF_DUE) {
    const st = readState();
    st.lastRun = new Date().toISOString();
    st.lastRunMode = 'if-due-dry';
    writeState(st);
    console.log('\n--if-due: dry pass recorded. DREAM_AUTO_APPLY=1 lets the daily run apply its two mechanical, reversible writes.');
  } else {
    console.log('\nDRY RUN — pass --apply to stamp curation state (the only write it makes).');
  }
  process.exit(0);
}

// ---- 5. apply: the reversible half only -----------------------------------
// Stamping curatedHash is all this does without a human. Description writing and
// supersession resolution are judgement, and stay queued.
// A probe PROPOSAL is not a reason to hold a document uncurated: it is advice
// about a memory that is otherwise finished, and letting it block the
// curation stamp would make every run re-queue the same descriptions forever.
const needsHuman = new Set(queue.filter((q) => q.kind !== 'probe-proposal').map((q) => q.file));
let stamped = 0;
const nowIso = new Date().toISOString();
for (const d of uncurated) {
  if (needsHuman.has(d.file)) continue;    // leave it uncurated so it re-queues
  state.curated[d.file] = { hash: d.hash, at: nowIso }; stamped++;
}
// Window docs the arm re-scored this run get a FRESH `at` (same hash), so the
// rolling window actually rolls instead of re-scoring the same head forever.
for (const d of rescored) {
  if (needsHuman.has(d.file)) continue;
  const cur = state.curated[d.file];
  if ((typeof cur === 'string' ? cur : cur?.hash) === d.hash) state.curated[d.file] = { hash: d.hash, at: nowIso };
}
if (ACCEPT.length) {
  state.acceptedSecrets = state.acceptedSecrets || {};
  for (const nameOrFile of ACCEPT) {
    const d = docs.find((x) => x.name === nameOrFile || x.file === nameOrFile);
    if (!d) { console.log(`  accept: no such memory "${nameOrFile}"`); continue; }
    state.acceptedSecrets[d.name] = d.hash;
    console.log(`  accepted (keep+index): ${d.name}`);
  }
}
state.lastRun = new Date().toISOString();
writeState(state);
console.log(`\napplied: stamped ${stamped} document(s) as seen; ${needsHuman.size} left queued for judgement.`);
