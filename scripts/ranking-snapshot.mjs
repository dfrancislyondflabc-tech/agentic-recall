#!/usr/bin/env node
// scripts/ranking-snapshot.mjs — a committed photograph of what this server answers.
//
//   node scripts/ranking-snapshot.mjs --corpus gold --out /tmp/after.json
//   node scripts/ranking-snapshot.mjs --compare test/ranking-snapshot-gold.json /tmp/after.json
//
// WHY A WHOLE-RESPONSE SNAPSHOT AND NOT A LIST OF NAMES. The plan's "Round 12" method compared
// ranked names plus `score` and `keywordScore` to six decimal places. The API rounds both to
// FOUR (lib/search.js:1170-1171), so three of those places were noise dressed as precision —
// and, worse, a name-and-score list cannot see a change in a snippet, a guidance line, an
// absence note or a freshness field, which is where most of this project's regressions live.
// So the snapshot is the entire canonicalised response minus the keys that cannot help but
// differ. That is strictly stronger, and it is honest about what it can resolve.
//
// THE CLOCK IS FROZEN BEFORE lib/search.js IS IMPORTED. `recencyFactor` (search.js:544-548)
// calls Date.now() at SCORE time, so an unfrozen clock drifts every score by ~1e-4 per hour —
// enough to make a byte-comparison fail for no reason at all, which is how a gate gets
// switched off. SNAPSHOT_NOW sets it; the corpus files' mtimes are stamped to fixed values for
// the same reason, because `modified` is a file mtime and a fresh temp copy has a fresh one.
//
// THE CORPUS. `--corpus gold` builds two real indexes over committed fixtures: curated from
// test/fixtures/gold-corpus (16 bike-workshop memories) and staging from exchange-shaped
// documents this file generates from that same vocabulary with fixed timestamps. Two corpora,
// because six of the 46 queries use an array scope and a one-corpus snapshot could not see the
// wrapper at all. `--corpus live` snapshots whatever the environment already points at; it is
// for a local before/after and is never committed, because a live list is derived from the
// author's own working vocabulary.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const argv = process.argv.slice(2);
const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

// ---- the frozen clock, before anything that could capture Date.now ------------------------
const NOW = Number(process.env.SNAPSHOT_NOW || Date.UTC(2026, 8, 1, 12, 0, 0));
const CORPUS_MTIME = NOW - 30 * 86400_000;      // every fixture, one month old, to the millisecond
Date.now = () => NOW;

// ---- compare mode --------------------------------------------------------------------------
if (argv.includes('--compare')) {
  const i = argv.indexOf('--compare');
  const [aPath, bPath] = [argv[i + 1], argv[i + 2]];
  if (!aPath || !bPath) { console.error('--compare needs two files'); process.exit(2); }
  const a = JSON.parse(readFileSync(aPath, 'utf8'));
  const b = JSON.parse(readFileSync(bPath, 'utf8'));
  const diffs = [];
  if (a.meta.mode !== b.meta.mode) {
    // A dense snapshot and a bm25-only one are not comparable, and pretending otherwise would
    // report every query as changed when the only thing that changed was the model cache.
    console.error(`REFUSING: retrieval mode differs (${a.meta.mode} vs ${b.meta.mode}) — these snapshots are not comparable`);
    process.exit(2);
  }
  const ids = [...new Set([...Object.keys(a.responses), ...Object.keys(b.responses)])].sort();
  for (const id of ids) {
    const x = JSON.stringify(a.responses[id]), y = JSON.stringify(b.responses[id]);
    if (x === y) continue;
    diffs.push({ id, query: (a.queries || {})[id] || (b.queries || {})[id] || '?', a: x, b: y });
  }
  if (!diffs.length) { console.log(`identical: ${ids.length} queries, ${a.meta.corpus} corpus, mode ${a.meta.mode}`); process.exit(0); }
  console.log(`${diffs.length} of ${ids.length} queries differ\n`);
  for (const d of diffs) {
    console.log(`--- ${d.id}  ${JSON.stringify(d.query)}`);
    console.log(`  A ${firstDiff(d.a, d.b)}`);
  }
  process.exit(1);
}

function firstDiff(x, y) {
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  const from = Math.max(0, i - 60);
  return `at char ${i}\n    …${x.slice(from, i + 100)}\n  B …${y.slice(from, i + 100)}`;
}

// ---- volatile keys ----------------------------------------------------------------------------
//
// Everything here changes between two runs that answered identically. The first nine were named
// in the plan; the rest were found by taking two snapshots on the same code and diffing them,
// which is the only way this list can be right.
const VOLATILE = new Set([
  'serverStartedAt', 'serverVersion', 'indexBuiltAt', 'indexPath', '_queryId', 'lastIngestAt',
  'indexCheckMs', 'indexCheckedFiles', 'newestSourceModified',
  'queryId', 'builtAt', 'ms', 'elapsedMs', 'statMs', 'checkMs', 'indexAgeHours',
  'corpusDir', 'path', 'file', 'indexBuiltAtByScope'
]);

/** Deep-sort keys and drop the volatile ones, so a diff is about the answer and nothing else. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = canonical(v[k]);
    }
    return out;
  }
  return v;
}

// ---- the gold corpora ---------------------------------------------------------------------
const GOLD = join(ROOT, 'test', 'fixtures', 'gold-corpus');

/**
 * Exchange-shaped staging documents, derived from the same bike-workshop vocabulary so the
 * array-scope queries have two real corpora to compare. Generated rather than committed
 * because they must carry FIXED timestamps and a fixed session id: their whole job is to be
 * byte-identical on every machine.
 */
const STAGING_EXCHANGES = [
  ['sealant', 'why did we stop stocking the small bottles of sealant', 'We stopped because it dried out before we could use it. The large bottle is the only size we buy now, and it goes on the shelf by the truing stand.'],
  ['freehub', 'the loaner wheel freehub is slipping again', 'Strip it and re-grease with light oil. Heavy grease in the pawls is what makes them stop engaging part-way up a climb, and the 1994 manual has that rule inverted.'],
  ['tension', 'how far do we bring spoke tension up per pass', 'Quarter turns, stress-relieving between passes. A wheel that is evenly tensioned will not need truing again for a season.'],
  ['till', 'who counted the till last Thursday', 'Two people count it at close and the float stays at fifty. The rest is bagged and logged in the book before it leaves the building.'],
  ['bleed', 'the rear brake feels spongy after the bleed', 'Bleed from the caliper upward and tap the hose to release trapped air. Do not overfill the reservoir before refitting the diaphragm.'],
  ['winter', 'where are the donated frames going this winter', 'They hang by the top tube in the back room. Steel gets a wipe of oil inside the seat tube because condensation collects there over a cold month.'],
  ['rota', 'can we move the Tuesday opening slot', 'The opener arrives half an hour early to put the stands out and switch on the compressor, so whoever takes it needs a key.'],
  ['chain', 'is this chain past saving', 'Measured at 0.6 percent, so it is a replacement rather than a clean. Past 0.75 the cassette usually goes with it.'],
  ['pressure', 'what pressure for the loaner with 28mm tyres', 'Around eighty psi for a rider under eighty kilos, lower on wet days. It is written on the tag.'],
  ['intake', 'someone brought in a child seat this morning', 'We turn those away, along with helmets and anything with a cracked frame, because we cannot certify them as safe.']
];

function buildGoldSandbox() {
  // A FIXED directory name, not mkdtemp. The corpus root's basename becomes each document's
  // `project` label (lib/config.js projectLabel), so a random temp name put a random string in
  // 38 of 46 responses and every comparison failed on it — the snapshot would have been a
  // photograph of mkdtemp. Fixed name, cleared first; `--sandbox` overrides it if two runs
  // ever need to overlap.
  const dir = resolve(val('sandbox', join(tmpdir(), 'recall-ranking-snapshot')));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const curated = join(dir, 'curated'), store = join(dir, 'store'), idx = join(dir, 'idx');
  // 🟥 AND A HOME, WITH AN EMPTY TRANSCRIPT FOLDER (S-1, 2026-09-05). Everything above is pinned
  // and one thing was not: `latest`/`search` attach uncapturedSessionsStamp() (lib/search.js:257),
  // which resolves transcripts through homedir() (lib/capture-status.js transcriptDirs()) — so the
  // snapshot embedded the running machine's live uncaptured-session count,
  // `"uncapturedSessions":{"count":141,…}`, in 11 of its 46 answers. Measured: 14 diffs against
  // the committed gold with ~/.claude/projects visible, 3 with MEMORY_TRANSCRIPT_DIR pointed at an
  // empty directory, deterministic per machine-state either way. A gate whose answer depends on
  // whose laptop ran it can never be green twice, and this one had been red — and therefore
  // unenforced — since 1.7.0.
  //
  // homedir() reads HOME on POSIX and USERPROFILE on Windows (uv_os_homedir), so both.
  const home = join(dir, 'home'), transcripts = join(home, '.claude', 'projects');
  for (const d of [curated, store, idx, transcripts]) mkdirSync(d, { recursive: true });

  for (const f of readdirSync(GOLD)) {
    if (!f.endsWith('.md')) continue;
    const p = join(curated, f);
    writeFileSync(p, readFileSync(join(GOLD, f)));
    stamp(p);
  }
  const sid = '5e9d0c11-2b44-4a77-9f30-6c1d2e3f4a5b';
  STAGING_EXCHANGES.forEach(([slug, ask, body], i) => {
    const ts = new Date(CORPUS_MTIME + i * 3_600_000).toISOString();
    const name = `x-${sid.slice(0, 8)}-${ts.replace(/[-:.]/g, '')}`;
    const md = `---\nname: ${name}\ndescription: "${ask.replace(/"/g, "'")}"\nmetadata:\n  type: exchange\n  account: snapshot-fixture\n  sessionId: ${sid}\n  sessionTitle: workshop bench notes\n  ts: ${ts}\n---\n\n**Asked:** ${ask}\n\n${body}\n`;
    const p = join(store, `${name}.md`);
    writeFileSync(p, md, 'utf8');
    stamp(p, i);
  });
  return { dir, curated, store, idx, home, transcripts };
}

function stamp(p, offset = 0) {
  const t = new Date(CORPUS_MTIME + offset * 3_600_000);
  utimesSync(p, t, t);
}

// ---- run --------------------------------------------------------------------------------------
const corpus = val('corpus', 'gold');
const outPath = val('out');
if (!outPath) { console.error('--out <file> is required'); process.exit(2); }

// The queries file is resolved through a variable on purpose: scripts/ ships in the public tree
// and test/ does not, so a literal join() here would be a read of a path that is not there —
// which scripts/audit-read-paths.mjs would (correctly) refuse.
const queriesDefault = [ROOT, 'test', 'ranking-snapshot-queries.json'].join('/');
const queriesPath = val('queries', queriesDefault);
if (!existsSync(queriesPath)) {
  console.error(`no query list at ${queriesPath}. Pass --queries <file>; the private list lives in test/.`);
  process.exit(2);
}
const QUERIES = JSON.parse(readFileSync(queriesPath, 'utf8'));

let sandbox = null;
if (corpus === 'gold') {
  sandbox = buildGoldSandbox();
  Object.assign(process.env, {
    MEMORY_DIR: sandbox.curated,
    MEMORY_OWN_STORE: sandbox.store,
    MEMORY_INDEX: join(sandbox.idx, 'curated.json'),
    MEMORY_STAGING_INDEX: join(sandbox.idx, 'staging.json'),
    MEMORY_HANDOFF_INDEX: '0',
    MEMORY_PROJECTS_INDEX: '0',
    MEMORY_LIBRARY: '0',
    MEMORY_ALL_PROJECTS: '0',
    MEMORY_VECTOR_CACHE: join(sandbox.idx, 'vectors.json'),
    MEMORY_QUERY_LOG: '0',
    MEMORY_PROBE_RESULTS: join(sandbox.idx, 'probes.json'),
    MEMORY_MARGIN_HISTORY: join(sandbox.idx, 'margins.jsonl'),
    MEMORY_ACCOUNT: 'snapshot-fixture',
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    MEMORY_TRANSCRIPT_DIR: sandbox.transcripts,
    MEMORY_MODEL_CACHE: process.env.MEMORY_MODEL_CACHE || join(ROOT, '.model-cache')
  });
}
// Pinned in both modes: telemetry must not count these, git must not be consulted, and an
// inline repair mid-run would change the corpus the second half of the list is asked of.
process.env.MEMORY_QUERY_SOURCE = 'test';
process.env.MEMORY_GIT_REPOS = '';
process.env.MEMORY_INLINE_REINDEX = '0';

const { buildIndex } = await import('../lib/index-store.js');
const { rootsForCorpus, indexPath, stagingIndexPath } = await import('../lib/config.js');

let mode = 'unknown';
if (corpus === 'gold') {
  const c = await buildIndex({ force: true, dir: rootsForCorpus('curated'), out: indexPath() });
  const s = await buildIndex({ force: true, dir: rootsForCorpus('staging'), out: stagingIndexPath() });
  mode = c.denseEnabled ? 'hybrid' : 'bm25-only';
  console.error(`[snapshot] curated ${c.fileCount} docs, staging ${s.fileCount} docs, mode ${mode}`);
}

// Through the HANDLER, not through search()/latest(): scope validation, the output guard and
// the JSON serialisation are all part of the answer, and all three have been wrong before.
const memory = await import('../tools/memory.js');
const registry = new Map();
memory.registerMemoryTools({ tool: (n, d, s, h) => registry.set(n, h) });
const handler = registry.get('memory');

const responses = {}, queryText = {};
for (const q of QUERIES) {
  const args = { action: q.action, query: q.query, ...(q.scope ? { scope: q.scope } : {}), ...(q.limit ? { limit: q.limit } : {}) };
  let body;
  try { body = JSON.parse((await handler(args)).content[0].text); }
  catch (e) { body = { __error: String(e.message) }; }
  responses[q.id] = canonical(body);
  queryText[q.id] = `${q.action} ${JSON.stringify(q.query)}${q.scope ? ' @' + JSON.stringify(q.scope) : ''}`;
}

writeFileSync(outPath, JSON.stringify({
  meta: { corpus, mode, now: NOW, queries: QUERIES.length, generator: 'scripts/ranking-snapshot.mjs' },
  queries: queryText, responses
}, null, 2) + '\n', 'utf8');
console.error(`[snapshot] ${QUERIES.length} queries -> ${outPath}`);

if (sandbox) rmSync(sandbox.dir, { recursive: true, force: true });
