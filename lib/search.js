// lib/search.js — hybrid retrieval over a loaded index.
//
// THREE retrievers with complementary failure modes:
//   * BM25 over title+description+headings+BODY — precise on jargon, part
//     numbers, file names, slugs, and (v1.1) any literal string in the text.
//   * Dense cosine over ~200-word body chunks — catches "how do I restart the
//     email app server" hitting a memory that never says "restart".
//   * Phrase proximity over the body (v1.1, lib/lexical.js) — did the query's
//     words occur TOGETHER. The tie-breaker that separates a quoted sentence
//     from a document with the same vocabulary.
// Fuse normalised scores, then apply the two-tier boost and a mild recency
// decay. Provenance (keyword / semantic / phrase / both) is reported so a bad
// result is diagnosable rather than mysterious.
//
// v1.1 also fixes two things the 2026-08-14 benchmark measured as defects:
// long documents winning the dense leg by sheer chunk count (see
// RETRIEVAL.longDoc), and the absence of any way to answer "nothing matched"
// (see RETRIEVAL.absence and `noStrongMatch` below).

import { RETRIEVAL, queryLogPath, indexPath, stagingIndexPath, indexPathForCorpus, CORPORA,
         libraryCorpora, isLibraryCorpus, categoryConfig,
         accountLabel, memoryDir as memoryDirPath, querySource} from './config.js';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { buildBm25, bm25Search, queryTermStats, bodyOf, tokenize } from './bm25.js';
import { bestWindow, snippetAround } from './lexical.js';
import { readUnindexed, unindexedGuidance } from './unindexed.js';
import { embedQuery, cosine, embeddingsDisabledReason } from './embed.js';
import { loadIndex, indexBuiltAtOnDisk } from './index-store.js';
import { guardValue, redact } from './secrets.js';
import { log } from './logger.js';
import { appendFileSync, statSync as statSyncFs, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isBenchmarkQuery } from './benchmark-strings.js';
import { rootsForScope, checkStaleness, reindexInline, staleWarningText, lastIngestAt,
         statSourceFiles } from './freshness.js';
import { captureHealth } from './ingest-health.js';
import { uncapturedSessionsStamp } from './capture-status.js';
import { runId, requestContext, configWarning } from './config.js';
import { serverVersionString, SERVER_STARTED_AT } from './version.js';
import { extractShas, verifyShas, configuredRepos, commitsInRange, corpusCurrency, autoVerifyQuery } from './git-join.js';
import { applyGraphSpread, graphSpreadEnabled, spreadAlpha } from './graph-spread.js';
import { spreadEffect, shadowDivergence } from './spread-telemetry.js';
import { floorsFor } from './absence-floors.js';
import { deriveProfile, adviceFor, verificationAppliesTo } from './corpus-profile.js';
import { orphanHandoffLines } from './orphan-handoffs.js';
import { isVec } from './vec.js';

// TELEMETRY THAT DOES NOT SHIP IS NOT IMPORTED EITHER — MEM-68/U-3.
//
// lib/ordinary-shadow.js is measurement scaffolding under a pre-registration
// (test/ordinary-word-shadow-preregistration.md): it computes a signal AFTER a refusal is
// decided, writes a line to a log, and can change no answer. 1.7.1 excluded it from every
// release artefact (packaging/release-exclude.json) — unproven instrumentation belongs in the
// tree where it is measured, not in everyone's install — and kept a lazy, optional import here
// so the file's absence could not break search.
//
// That was still not enough, and the upgrade path is why. Unzipping 1.7.1 over a 1.7.0 install
// leaves 1.7.0's copy of the module on disk; the lazy import then FINDS it, and the exclusion is
// undone by a file nobody deleted. Measured on two installs, same corpus, same three refusal
// queries with MEMORY_QUERY_SOURCE=live: the upgraded install wrote 3 rows carrying the query
// text verbatim to <install>/.shadow/ordinary-word-shadow.jsonl; the fresh one wrote none
// (campaign D.4, reproduced twice). An install that quietly runs code and writes a second
// query-bearing sidecar because of what an OLD zip left behind is not something a release
// exclusion can fix.
//
// So the call site is gone, not guarded: the exclusion is the decision, and now nothing on disk
// can reverse it. The measurement is not lost — the module still lives in the repo and its own
// group (a22) drives observeAbsence() directly. Resuming a LIVE measurement means re-adding a
// call here, in the tree where it is being measured, deliberately.

// One cache PER SCOPE. The indexes must never share BM25 statistics OR the
// corpus-derived constants below — that is the whole reason they are separate
// files, and it is measured twice over (see lib/config.js): blending staging
// cost MRR 0.826 -> 0.681, and blending the handoff documents cost 0.8194 ->
// 0.7986 plus an absence verdict, entirely by moving `referenceChunks`.
const CACHES = new Map();      // scope -> loaded index + its own statistics

// scope -> the on-disk `builtAt` of an index file whose header read but whose body would not load.
// Only ensureFresh's adoption branch writes it, and only to stop one broken file from costing a
// full JSON.parse on every query. Any DIFFERENT builtAt is tried immediately.
const ADOPT_FAILED = new Map();

// Map every exchange to its position in its own thread, and to that thread's
// LAST exchange.
//
// `threadLast` is the field that does the work. Measured on the real corpus:
// mean thread length 36.7, and 87% of exchanges sit in threads >=20 long -- so
// "you are at 12 of 47" is almost always true and almost never discriminating.
// It tells the caller to go looking without saying where. The NAME of the final
// exchange puts the last word one get() away.
// THE SUFFIX IS A STRING, SORTED AS A STRING. Names used to be `x-<sid8>-NNNN` (a positional
// ordinal) and are now `x-<sid8>-<ask timestamp compacted, 20260903T054233800Z>` — content-stable, so
// an extractor rule that inserts or drops an exchange no longer renumbers every later file (MEM-19/20/
// 21: renumbering duplicated 19 memories and a bound computed from the ordinal deleted a real one).
// The compact form is fixed-width UTC, so byte order IS time order, and legacy `0001` sorts before any
// `2026…` during a migration window. 🟥 Never parse the suffix as a Number: 20260903054233800 exceeds
// MAX_SAFE_INTEGER and two adjacent milliseconds compare EQUAL — measured. `[^-]+` for the session
// because sid8 is hex and never contains a dash, so the greedy suffix cannot eat into it.
export function buildThreadMap(docs) {
  const bySession = new Map();
  for (const d of docs) {
    const m = /^x-([^-]+)-(.+)$/.exec(d.name || '');
    if (!m) continue;
    const [, sid, ord] = m;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ name: d.name, ord: String(ord), ts: Date.parse(d.ts || '') || null, legacy: /^\d{4}$/.test(ord) });
  }
  const out = new Map();   // exchange name -> { position, total, last, names }
  for (const [, list] of bySession) {
    // A session holding BOTH shapes cannot be ordered by name: a legacy `0004` written AFTER the
    // migration (a copy running the old writer) sorts to the FRONT, and `threadLast` then points two
    // days back (reviewed, reproduced). Order such a session by the ask timestamp every doc carries.
    const mixed = list.some((e) => e.legacy) && list.some((e) => !e.legacy);
    if (mixed && list.every((e) => e.ts !== null)) list.sort((a, b) => a.ts - b.ts);
    else list.sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0));
    const names = list.map((e) => e.name);   // ONE array shared by every member
    const last = names[names.length - 1];
    list.forEach((e, i) => out.set(e.name, { position: i + 1, total: list.length, last, names }));
  }
  return out;
}

function loadScope(scope) {
  const path = indexPathForCorpus(scope);
  if (!path) return { present: false, docs: [], headerProblems: [], dense: false };
  const t0 = Date.now();
  const idx = loadIndex(path);
  const chunkCounts = idx.docs.map((d) => (d.chunks || []).length).sort((a, b) => a - b);
  const entry = {
    ...idx,
    bm25: idx.docs.length ? buildBm25(idx.docs) : null,
    // The reference length for the dense-leg correction, derived from THIS
    // corpus rather than hard-coded: documents up to the 90th percentile are
    // "normally long" and pay nothing. Using the median instead cost the
    // benchmark's P1 — `chat-watcher-speedup` is a legitimately long memory
    // at 23 chunks and lost a third of its dense score for it. Only the tail
    // above p90 is the multiple-draws problem worth correcting.
    //
    // DERIVED PER CORPUS, and that is load-bearing: this one number is what
    // made the handoff documents regress the curated benchmark from inside the
    // same index without ever appearing in a result.
    referenceChunks: Math.max(1, chunkCounts[Math.floor(0.90 * (chunkCounts.length - 1))] || 1),

    // WHERE IN ITS THREAD each exchange sits, computed once per index and cached
    // here beside referenceChunks. Exchange names are x-<session>-<ask timestamp>, so the
    // ordering is already in the corpus and needs no NLP and no guessing.
    //
    // This exists because of a specific failure: a session asked whether a
    // re-parse had finished, got the exchange where the work STARTED, and
    // reported the answer unknowable -- while reading one exchange of a
    // 650-exchange thread. It could not see that it was mid-thread.
    //
    // The obvious alternative -- warn when a result "looks unresolved" -- was
    // measured and rejected: that vocabulary fires on 24% of all exchanges,
    // which at limit:8 puts a warning on ~87% of searches. This repo has been
    // burned by exactly that twice (see the correction regex at 76%). Thread
    // position is never a guess and never cries wolf.
    threads: buildThreadMap(idx.docs),

    // WHAT KIND of corpus this is, derived once per index from structural counts.
    // Cached here beside referenceChunks because it is the same shape of fact: a
    // per-corpus constant that must never be computed from a blend of corpora.
    // A library category may DECLARE its domain (.category.json) — a statute
    // and a novel are statistically identical prose, and only the author of the
    // category knows which advice fits. Absent, the derived profile decides.
    profile: deriveProfile(idx.docs.map((d) => ({
      bodyText: (d.chunks || []).map((c) => c.text || '').join(' ') || d.description || ''
    })), isLibraryCorpus(scope) ? { override: categoryConfig(scope).domain || null } : {}),

    // The newest thing this corpus knows about, computed once. Used to say how far
    // behind the world it is -- the one limit no query can work around.
    newestTs: idx.docs.reduce((m, d) => {
      const t = Date.parse(d.ts || d.modified || 0) || 0;
      return t > m ? t : m;
    }, 0)
  };
  log(`index loaded [${scope}]: ${idx.docs.length} docs, dense=${idx.dense}, refChunks=${entry.referenceChunks}, ${Date.now() - t0} ms` +
      (idx.headerProblems.length ? ` (header problems: ${idx.headerProblems.join('; ')})` : ''));
  return entry;
}

export function getIndex({ reload = false, scope = 'curated' } = {}) {
  if (reload) CACHES.delete(scope);
  if (!CACHES.has(scope)) CACHES.set(scope, loadScope(scope));
  return CACHES.get(scope);
}

export function invalidate(scope = null) {
  if (scope) CACHES.delete(scope);
  else CACHES.clear();
}

// ---- THE STALENESS GUARD (see lib/freshness.js for the incident) ----------
//
// An index is a cache of a directory, so it needs an invalidation rule. Before
// this existed, a search answered from whatever snapshot happened to be on disk
// and said nothing about its age; on 2026-08-19 that served an 06:18 index all
// day over files edited at 07:13 and 20:46.
//
// The rule: check, repair if the repair is cheap, and otherwise ADMIT. What is
// never allowed is answering from a stale index without saying so.
//
// Returns { idx, stamp } where `stamp` is the set of fields every search
// response carries.
async function ensureFresh(scope) {
  const roots = rootsForScope(scope);
  const out = indexPathForCorpus(scope);
  let idx = getIndex({ scope });

  // 🟥 ADOPT AN INDEX SOMEONE ELSE REBUILT. This must come FIRST, before staleness is computed.
  //
  // CACHES holds the parsed index for the life of the process, and everything below compares the
  // CORPUS against that cached copy. Nothing compared the cached copy against the index FILE. So a
  // rebuild by another process -- scripts/auto-ingest.js owns the staging rebuild, by design --
  // was invisible here: the cache kept answering, and the freshness check kept reporting the
  // corpus as "ahead of the index" when the index on disk had already caught up.
  //
  // Measured 2026-09-03: on-disk index built 13:36Z, server answering from 06:51Z (7 hours). The
  // same query returned 0 results through the server and 2 against the on-disk index. The failure
  // is not a bad ranking, it is a confident ABSENCE over an answer that already existed.
  //
  // Cost is one 4 KB read against an existing per-query corpus scan (indexCheckMs ~42 on 2,794
  // files). The on-disk timestamp must parse before anything happens, so an unreadable or
  // headerless index changes nothing.
  //
  // 🟥 AND A SERVER BORN WITHOUT AN INDEX MUST ADOPT ITS FIRST ONE (A-D1, campaign A, 2026-09-05).
  // This used to require BOTH timestamps: `if (onDiskBuiltAt && loadedBuiltAt)`. A process that
  // started when no index file existed has `loadedBuiltAt === null` for the life of the process --
  // `present:false` is cached like any other load -- so the adoption branch could never fire, and
  // the ONE case this whole feature is for was the one case it excluded. A fresh install answers
  // `indexBuiltAt: null`, `indexStale: true`, 0 rows FOREVER, while a complete index its own
  // capture built sits beside it on disk. Measured: same server 0 rows after the build, a fresh
  // server over the identical files 3 rows. Missing is simply the oldest possible index, so
  // -Infinity is the honest comparand.
  const onDiskBuiltAt = indexBuiltAtOnDisk(out);
  const loadedBuiltAt = idx?.header?.builtAt || null;
  const adoptedFromAbsence = !!onDiskBuiltAt && !loadedBuiltAt;
  let reloadedFromDisk = false;
  if (onDiskBuiltAt && ADOPT_FAILED.get(scope) !== onDiskBuiltAt) {
    const a = Date.parse(onDiskBuiltAt), b = loadedBuiltAt ? Date.parse(loadedBuiltAt) : -Infinity;
    if (Number.isFinite(a) && a > b) {
      invalidate(scope);
      idx = getIndex({ scope, reload: true });
      reloadedFromDisk = true;
      // A file whose 4 KB header parses but whose BODY does not is the one way this can retry on
      // every query -- a 130 MB JSON.parse each time. Remember the build that did not load and
      // stop asking for it; a NEWER build on disk has a different stamp and is tried at once.
      if (!idx.present) { ADOPT_FAILED.set(scope, onDiskBuiltAt); reloadedFromDisk = false; }
      else ADOPT_FAILED.delete(scope);
    }
  }

  const stamp = {
    indexBuiltAt: idx?.header?.builtAt || null,
    indexPath: out,
    indexStale: false,
    // Said once, in the response, because saying it only in the docs did not
    // stop it from being misread.
    modifiedFieldNote: "each result's `modified` is that file's mtime AT INDEX TIME (see indexBuiltAt), not a live stat — memory({action:'get'}) returns a live one",
    serverVersion: serverVersionString(),
    serverStartedAt: SERVER_STARTED_AT
  };
  // 🟥 MEM-68/U-4 — A CONFIG MISTAKE, SAID WHERE THE ANSWER IS READ. An install upgraded in
  // place from 1.7.0 keeps that version's config (MEMORY_DIR without MEMORY_LIBRARY_DIR), so
  // every library category is silently outside every scope, including 'everything'. index.js
  // logs it once at boot; the log is not what a caller reads. Absent when the config is right,
  // so an ordinary response gains nothing. See lib/config.js configWarning().
  const cfgWarn = configWarning();
  if (cfgWarn) stamp.configWarning = cfgWarn;
  if (reloadedFromDisk) {
    stamp.indexReloadedFromDisk = true;
    stamp.indexReloadNote = adoptedFromAbsence
      ? `This server started before any index for '${scope}' existed; one built at ${onDiskBuiltAt} was ` +
        'found on disk and read before this search ran. These results are current.'
      : `The index was rebuilt by another process (on disk ${onDiskBuiltAt}, this ` +
        `server had ${loadedBuiltAt}); it was re-read before this search ran. These results are current.`;
  }
  if (scope === 'staging') {
    stamp.lastIngestAt = lastIngestAt();
    // THE CAPTURE SIDE OF FRESHNESS, SAID ON THE QUERY PATH. Everything else in this stamp compares
    // the index to the STORE. These two compare the store to the WORLD: did the last capture run die
    // between writing and indexing (MEM-26 — lib/ingest-health.js), and is there a transcript that
    // has grown past its last capture (MEM-26/WP3b — lib/capture-status.js)? Both are absent when
    // all is well, so an ordinary response gains nothing; neither throws.
    const health = captureHealth();
    if (!health.healthy) stamp.captureHealth = health;
    const gaps = uncapturedSessionsStamp();
    if (gaps) stamp.uncapturedSessions = gaps;
  }
  if (scope === 'handoff') {
    stamp.corpusNote = 'Institutional handoff documents, indexed READ-ONLY from outside the memory folders. ' +
      'Their own index, so they cannot move a curated score.';
  }
  if (scope === 'projects') {
    stamp.corpusNote = 'Hand-written memories from OTHER projects\' memory folders (~/.claude/projects/<project>/memory). ' +
      'Curated-type content at hot tier, writable, each row carrying its `project` — but its own index, ' +
      'so it cannot move a curated score.';
  }
  if (isLibraryCorpus(scope)) {
    stamp.corpusNote = `Library category '${scope}' — imported reference material (books/manuals/docs), ` +
      'indexed READ-ONLY in its own index with its own statistics. Never searched unless named ' +
      "(or via scope:'everything'), so it cannot move a work-corpus score.";
  }

  // LIBRARY CORPORA ARE NEVER REBUILT INLINE — the staging exemption, for the
  // staging reason at book scale: one imported manual is hundreds of chunks, so
  // "incremental" over a changed book is minutes of embedding a query must not
  // wait for. Import/index own these builds.
  const libraryScope = isLibraryCorpus(scope);

  if (!idx.present) {
    // NO INDEX AT ALL. For curated or staging that stays an admission (the build
    // is minutes). For a corpus small enough to build in seconds it is built now
    // — the day-2 case, where another project has just written its first
    // memories and nothing has indexed them yet. See reindexInline.
    const first = out && scope !== 'staging' && !libraryScope
      ? await reindexInline({ idx, roots, out, staleness: null })
      : { ok: false,
          reason: libraryScope
            ? `the '${scope}' library index is import-driven — build it with memory({action:"index", scope:"${scope}"})`
            : 'the staging index is ingest-driven — scripts/auto-ingest.js owns it' };
    if (first.ok) {
      invalidate(scope);
      idx = getIndex({ scope, reload: true });
      stamp.indexBuiltAt = idx?.header?.builtAt || null;
      stamp.indexBuiltInline = true;
      stamp.indexReindexSeconds = first.seconds;
      stamp.indexReindexNote =
        `This corpus had no index; it was small enough to build inline (${first.report.filesIndexed} files, ` +
        `${first.report.chunkCount} chunks, ${first.seconds}s) before this search ran. These results are current.`;
      return { idx, stamp };
    }
    // 🟥 AND THE DIRECT READ MUST BE ARMED HERE TOO (MEM-47 / A-D2, campaign A, 2026-09-05).
    //
    // This branch used to return with `staleFiles: null` and nothing else, so `attachStaleFiles()`
    // never ran, `stamp._staleScan` was undefined, and lib/unindexed.js returned on its first line.
    // The store-is-truth safety net — the one thing that makes recent recall independent of whether
    // a rebuild ran — was INERT in the single state where the index can help least: a fresh install
    // whose first build has not finished. Measured: three store files carrying the queried token,
    // no staging index, `latest` → 0 rows, `unindexedChecked: null`, `recentUnindexed: null`, and a
    // staleWarning that named no file. Nothing returned and nothing named.
    //
    // An absent index is not a special case, it is the EMPTY one: `checkStaleness` against
    // `{docs: [], excluded: []}` classifies every live store file as `added`, which is exactly what
    // it is. Same function, same gates downstream (exclusionReason / scrubSections in
    // lib/unindexed.js), same bound — so a denylisted or `metadata.secret` file is refused here for
    // the same reason it is refused everywhere else.
    //
    // Cost is the corpus stat pass this branch was skipping, the one every other branch already
    // pays. It cannot become a new way to fail: an unreadable corpus directory is reported in
    // `freshnessCheckError` and the admission below is returned unchanged.
    let none = null;
    try {
      // `out` guards a corpus that is switched OFF (MEMORY_STAGING_INDEX=0 -> indexPathForCorpus
      // null): off is off, and its loadScope entry is the bare shape, not a full one.
      if (out) none = checkStaleness(idx, roots);
    } catch (e) {
      stamp.freshnessCheckError = e.message;
    }
    if (none) {
      stamp.indexCheckedFiles = none.checkedFiles;
      stamp.indexCheckMs = none.checkMs;
      stamp.newestSourceModified = none.newestSourceModified;
    }
    // Carried so latestAll() can word the array-scope note the same way (`r.indexCorrupt`).
    stamp.indexCorrupt = !!idx.corrupt;

    // 🟥 MEM-85 — AN EMPTY CORPUS IS NOT A STALE ONE, AND MUST NOT SPEAK FOR THE OTHERS.
    //
    // Measured 2026-09-07 on a live 1.7.2 Mac (payload:
    // MEMORY-MCP-AGENT-REPORTS-2026-09-05/mac-chat-search-all-evidence-2026-09-07.json). One
    // scope:'all' response, four sections: curated fresh, staging FRESH with 10 ranked hits from a
    // 2,983-file index built 7 minutes earlier, handoff fresh — and `projects`, which on that
    // machine has no other project's memory folder at all: 0 corpus files, no index. The top level
    // read `indexStale: true`, `staleFiles: 0`, and "There is no index on disk, so nothing here was
    // RANKED from the corpus", because the aggregate ORs `indexStale` across scopes and took its
    // warning text from the one that set it. A caller who believes the envelope abandons a search
    // that succeeded.
    //
    // Two states, told apart HERE — once — so both aggregate builders and every reader inherit the
    // distinction instead of re-deriving it:
    //   EMPTY  0 corpus files AND no index. There is nothing to rank, nothing to build, and nothing
    //          to be behind. A complete answer for this corpus, and no claim about any other.
    //   STALE  corpus files exist and the index is absent, corrupt, or behind them. THAT is the
    //          state the warning was written for.
    // `checkedFiles` is the count the freshness pass already made; a corpus whose index is switched
    // OFF (`out === null`, so no staleness pass ran) is counted directly — its roots are usually
    // empty too, and "off with nothing in it" is empty, not stale.
    let corpusFiles = none ? none.checkedFiles : null;
    if (corpusFiles === null) {
      try { corpusFiles = statSourceFiles(roots).count; } catch { /* unknown: treated as NOT empty */ }
    }
    if (corpusFiles === 0) {
      stamp.empty = true;
      stamp.staleFiles = 0;
      // The sentence stays where it is TRUE — in this corpus's own section. What changes is that it
      // is no longer `staleWarning`, so no aggregate can hoist it over three fresh corpora. One
      // line, because MEM-86 measured what nineteen stamped fields per empty section cost.
      stamp.emptyNote = (idx.corrupt
        ? `the index file at ${out} exists but is unreadable, and '${scope}' holds 0 corpus files`
        : `'${scope}' holds 0 corpus files and has no index`) +
        ' — nothing to rank and nothing to build, so this section is a COMPLETE answer for this ' +
        'corpus and makes no claim about the others in this response. Write a memory into it (or ' +
        'point the corpus at a folder) and memory({action:"index"}) will build one.';
      return { idx, stamp };
    }

    stamp.indexStale = true;
    stamp.staleFiles = none ? none.staleFiles : null;
    // "retrieved" was the wrong word even before the fix and is the wrong word after it: the
    // corpus IS read on this branch now, it is simply not RANKED. Say which of the two happened.
    // MISSING AND CORRUPT ARE DIFFERENT FILES AND DIFFERENT ADVICE (MEM-51/MEM-59). `idx.corrupt`
    // comes from lib/index-store.js loadIndex's whole-file check: the file is THERE and does not
    // parse. Saying "there is no index on disk" about it sent a tester hunting for a missing file.
    stamp.staleWarning = (idx.corrupt
      ? `The index file at ${out} EXISTS but is unreadable (truncated or corrupt), so nothing here was RANKED from the corpus. `
      : 'There is no index on disk, so nothing here was RANKED from the corpus. ') +
      `Run memory({action:"index"}). Not built inline because ${first.reason}.` +
      (none && none.staleFiles
        ? ` Every one of the ${none.staleFiles} file(s) in this corpus is unindexed (${none.addedNamed.join(', ')}` +
          `${none.added.length > none.addedNamed.length ? ', …' : ''}); the newest of them are read DIRECTLY ` +
          'for this answer (see `unindexedChecked` for how many, and `recentUnindexed` on a search).'
        : '');
    if (none) attachStaleFiles(stamp, none);
    return { idx, stamp };
  }

  let st;
  try {
    st = checkStaleness(idx, roots);
  } catch (e) {
    // The guard is a safety feature; it may not become a new way to fail a
    // search. An unreadable corpus directory is reported, not thrown.
    stamp.freshnessCheckError = e.message;
    return { idx, stamp };
  }

  stamp.indexCheckedFiles = st.checkedFiles;
  stamp.indexCheckMs = st.checkMs;
  stamp.newestSourceModified = st.newestSourceModified;

  if (!st.stale) return { idx, stamp };

  // Staging is ingest-driven and its rebuild writes 130 MB in ~14 s; a query
  // does not wait for that. The same holds for a library category — a changed
  // book re-embeds hundreds of chunks. Curated gets the inline repair.
  if (scope === 'staging' || libraryScope || !out) {
    stamp.indexStale = true;
    stamp.staleFiles = st.staleFiles;
    stamp.staleWarning = staleWarningText(st, libraryScope
      ? `the '${scope}' library index is import-driven and a changed book is a full re-embed — rebuild with memory({action:"index", scope:"${scope}"})`
      : 'the staging index is ingest-driven and its rebuild is not cheap enough to run inline — scripts/auto-ingest.js owns it');
    // 2026-08-29: this branch used to return WITHOUT the file lists. So
    // staleTermCollision — written for exactly this failure — was inert on the
    // only corpus that can suffer it: curated repairs itself inline and never
    // reaches a stale answer, while staging always does. The guard read
    // stamp.staleFilesAdded, which was undefined here, and silently found nothing.
    attachStaleFiles(stamp, st);
    return { idx, stamp };
  }

  const repair = await reindexInline({ idx, roots, out, staleness: st });
  if (repair.ok) {
    invalidate(scope);
    idx = getIndex({ scope, reload: true });
    stamp.indexBuiltAt = idx?.header?.builtAt || null;
    stamp.indexStale = false;
    stamp.indexReindexedInline = true;
    stamp.indexReindexSeconds = repair.seconds;
    stamp.indexReindexNote =
      `The index was ${st.staleFiles} file(s) behind the corpus (built ${st.indexBuiltAt}); it was rebuilt ` +
      `incrementally before this search ran (${repair.report.filesReused} files reused, ${repair.report.filesEmbedded} re-embedded). ` +
      'These results are current.';
    return { idx, stamp };
  }

  stamp.indexStale = true;
  stamp.staleFiles = st.staleFiles;
  stamp.staleWarning = staleWarningText(st, repair.reason);
  attachStaleFiles(stamp, st);
  return { idx, stamp };
}

// Both stale branches attach the same evidence, through one function, because
// they drifted once already and the drift was invisible: the display slices are
// capped at MAX_NAMED (8) so a stale list can never become the response, while the
// FULL set rides non-enumerably for the scanners — `...stamp` spreads only
// enumerable own properties, so it reaches staleContentScan and never the caller.
function attachStaleFiles(stamp, st) {
  // The newest UNINDEXED mtime. `latest` compares it against its own top row: if unread
  // content is newer than the newest thing that can be ranked, a newest-first answer is not
  // the last word, whatever it ranked. See the recency block in latestIn().
  stamp.staleNewestModified = st.staleNewestModified ?? null;
  Object.defineProperty(stamp, '_staleNewestMs', { value: st.staleNewestMs ?? null, enumerable: false, configurable: true });
  // 🟥 MEM-41 / big-test P-1. These three lists are where a denylisted or `metadata.secret`
  // FILENAME used to enter the response — through staleTermCollision (name match), through
  // staleContentScan (which readFileSync'd every entry of `_staleScan` and quoted which file a
  // queried token was found in), and through recencyVoid's "READ THESE FIRST: …". checkStaleness
  // has already dropped the gated ids from the *Named lists.
  //
  // `_staleScan` deliberately KEEPS them. It is the honest answer to "which files has this index
  // not read", and lib/unindexed.js needs it whole so it can apply the indexer's own gates and
  // report `unindexedChecked: {scanned, merged, excluded}` — the count is the honesty, and losing
  // it here would make a refusal indistinguishable from a file that was never there. The gate
  // instead rides beside it as `_gatedFileIds`, and every channel that would NAME a file consults
  // it: staleContentScan (below) and readUnindexed's unread list.
  stamp.staleFilesChanged = st.changedNamed;
  stamp.staleFilesAdded = st.addedNamed;
  stamp.staleFilesRemoved = st.removedNamed;
  if (st.gatedFiles) stamp.gatedFiles = st.gatedFiles;
  Object.defineProperty(stamp, '_gatedFileIds', {
    value: st.gated || new Set(), enumerable: false, configurable: true });
  Object.defineProperty(stamp, '_staleScan', {
    value: [...st.changed, ...st.added]
      .map((id) => ({
        fileId: id,
        path: st.pathById ? st.pathById.get(id) : null,
        // Carried so lib/unindexed.js can read the NEWEST unread files first under its bound.
        mtimeMs: st.mtimeById ? st.mtimeById.get(id) ?? null : null,
        // MEM-87: the root descriptor, so the direct row carries `project`/`account`/tier like the indexed one.
        root: st.rootById ? st.rootById.get(id) ?? null : null
      }))
      .filter((f) => f.path),
    enumerable: false, configurable: true
  });
}

/**
 * Per-query-max normalisation. ONLY safe when the scores are not about to be
 * fused with a second retriever: it guarantees a 1.0 to whatever scored best,
 * so it says "the best of these" and never "this is a good match". Kept for
 * bm25-only mode, where that distinction cannot affect anything.
 */
function normalise(map) {
  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  const out = new Map();
  if (max <= 0) return out;
  for (const [k, v] of map) out.set(k, v / max);
  return out;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * ABSOLUTE keyword scale — the fused path's normalisation.
 *
 * Two factors, both measured (see RETRIEVAL.keywordScale in config.js for the
 * distributions the numbers come from):
 *   magnitude — where the raw BM25 score sits between a noise floor and the
 *               score a real lexical match earns;
 *   coverage  — how much of what this query COULD have matched the document
 *               actually matched, which is what separates "answered the
 *               question" from "shares one common word".
 *
 * Both are needed: magnitude alone lets a long query that hits a single rare
 * term score high; coverage alone lets a three-word query that matches its two
 * common words score 1.0. A document below the floor scores 0 and rides on its
 * semantic score alone — no keyword evidence is the honest reading.
 *
 * The two reference points are each the lesser of an absolute raw score and a
 * share of the query's achievable score, so that a short exact query, which
 * cannot reach the absolute bar however perfectly it matches, is judged against
 * what it could actually have earned.
 *
 * Ranking WITHIN the keyword leg is untouched (the map is monotone in the raw
 * score for a fixed query); only its magnitude relative to the dense leg moves.
 */
function absoluteKeyword(rawScores, stats) {
  const { absFloor, absFull, covFloor, covFull } = RETRIEVAL.keywordScale;
  const ideal = stats.ideal;
  const out = new Map();
  if (ideal <= 0) return out;                    // no query term exists in the corpus
  const floorPoint = Math.min(absFloor, covFloor * ideal);
  const fullPoint = Math.min(absFull, covFull * ideal);
  for (const [k, raw] of rawScores) {
    const magnitude = clamp01((raw - floorPoint) / (fullPoint - floorPoint));
    // 🟥 A DOCUMENT BELOW THE FLOOR IS DROPPED FROM THE KEYWORD LEG ENTIRELY, and that is where
    // the body-quote cliff was traced to. Measured 2026-09-03 on the curated corpus: a memory
    // containing the query VERBATIM in its body ranks 2nd-4th of 400 by raw BM25F -- the body is
    // indexed (fieldWeights.body 0.3) -- and is dropped every time:
    //
    //   query                                        ideal  floorPoint  docRaw
    //   "silently corrupt"                            7.59      4.555    2.643
    //   "silently corrupt which is the whole point"  12.99      7.795    3.782
    //
    // floorPoint is covFloor(0.6) x ideal, and `ideal` assumes FULL field weight, so a body-only
    // match sits near 30% of ideal and can never reach a 60% floor.
    //
    // REJECTED, with the numbers that killed it: keeping sub-floor documents at a damped
    // proportional weight (`MEMORY_KEYWORD_SUBFLOOR`, since removed). A/B over 45 verbatim body
    // sentences from real curated memories:
    //
    //   arm A (this code)          rank1 25  top5 26  missing 18  MRR 0.5685
    //   arm B damp 0.25            rank1 25  top5 26  missing 18  MRR 0.5698
    //   arm B damp 1.0             rank1 25  top5 26  missing 18  MRR 0.5684
    //   arm B damp 4.0             rank1 25  top5 26  missing 19  MRR 0.5667
    //
    // Nothing moved. The floor is NOT the binding constraint, so lowering it buys nothing and
    // would only weaken a tuned guard.
    //
    // What the same measurement DID find: 17 of the 18 misses are one hazard, not a general one --
    // `claude-diagnostic-guide-mac` (9) and `-windows` (8), large documents whose #section children
    // compete with each other and with their parent. Restricted to whole documents the leg is
    // healthy: n=28, rank1 24, missing 3. Any future work here belongs on SECTION COMPETITION,
    // not on this floor.
    if (magnitude <= 0) continue;
    out.set(k, magnitude * clamp01((raw / ideal) / covFloor));
  }
  return out;
}

/**
 * Dense-leg length correction. `nChunks` draws from a document's chunk-score
 * distribution beat `few` draws on the maximum alone, so a document with 517
 * chunks out-scores a three-line standing rule without being more relevant.
 * Shrink the dense score toward the corpus-median document, and waive the
 * shrinkage in proportion to keyword evidence — a document with concentrated
 * lexical hits has already passed BM25's own length test.
 */
/**
 * The phrase leg's DEADBAND.
 *
 * Below the floor, a "phrase score" is not evidence of a quote — it is the
 * incidental co-occurrence any two documents about the same subject produce,
 * and letting it into the fused score means a near-tie gets decided by noise.
 * Measured: benchmark probe E9 has its correct answer and a sibling within 0.9%
 * of each other, the correct one ahead on keyword score by 3.3×; raw phrase
 * scores of 0.13 vs 0.08 — both meaningless — flipped it. Meanwhile every
 * genuine quote in the verbatim category scores 0.56 or higher.
 *
 * So the leg contributes nothing until 0.35 and then rescales to full weight,
 * which makes it do exactly what it is documented to do: fire on quotes, stay
 * silent otherwise.
 */
function phraseContribution(phrase) {
  const floor = RETRIEVAL.fuse.phraseFloor;
  if (!(phrase > floor)) return 0;
  return (phrase - floor) / (1 - floor);
}

// file -> total chunks across every doc from that file, memoised per index.
// Section children share their parent's `file`, which is also what lets
// capPerDocument cap a parent and its children together.
const CHUNKS_BY_FILE = new WeakMap();
function chunksByFile(idx) {
  let m = CHUNKS_BY_FILE.get(idx);
  if (m) return m;
  m = new Map();
  for (const d of idx.docs || []) m.set(d.file, (m.get(d.file) || 0) + (d.chunks || []).length);
  CHUNKS_BY_FILE.set(idx, m);
  return m;
}

function longDocFactor(nChunks, referenceChunks, kw, waiverOverride) {
  const { alpha, keywordWaiver } = RETRIEVAL.longDoc;
  if (nChunks <= referenceChunks || alpha <= 0) return 1;
  const raw = Math.pow(referenceChunks / nChunks, alpha);
  const waive = clamp01(kw / (waiverOverride || keywordWaiver));
  return raw + (1 - raw) * waive;
}

// ---- PHASE B: how big is a section, for the purpose of being penalised? ----
//
// The two obvious answers are both wrong, and each is wrong in the opposite
// direction (both measured, 2026-08-25):
//
//   own chunks    -> a 635 KB changelog becomes 138 short documents, none of
//                    them penalised. It took a top-3 slot on 20 of 32 probes.
//   parent chunks -> a section is punished for its parent's bulk and can never
//                    win, which loses the entire point of splitting.
//
// So blend them geometrically and let the exponent be measured, not asserted:
//   beta = 0  -> own size          (flooding)
//   beta = 1  -> parent size       (section can never win)
// and give a child its own keyword waiver, because the case a section SHOULD
// win is exactly the one where a specific term matches it hard ("Gate #24").
const sectionBeta = () => {
  const v = Number(process.env.MEMORY_SECTION_BETA);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
};
const sectionWaiver = () => {
  const v = Number(process.env.MEMORY_SECTION_WAIVER);
  return Number.isFinite(v) && v > 0 ? v : RETRIEVAL.longDoc.keywordWaiver;
};
function sectionEffectiveChunks(own, parent) {
  const b = sectionBeta();
  if (b <= 0) return own;
  if (b >= 1) return parent;
  return Math.exp((1 - b) * Math.log(Math.max(1, own)) + b * Math.log(Math.max(1, parent)));
}

/** Map a raw bge cosine onto 0..1 across the band this corpus actually uses. */
function rescaleCosine(cos) {
  const { floor, span } = RETRIEVAL.semanticScale;
  return Math.max(0, Math.min(1, (cos - floor) / span));
}

function recencyFactor(modified) {
  const { floor, halfLifeDays } = RETRIEVAL.recency;
  const t = Date.parse(modified);
  if (!Number.isFinite(t)) return 1;
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  return floor + (1 - floor) * Math.exp(-ageDays / halfLifeDays);
}

function tierBoost(doc) {
  const { boost } = RETRIEVAL;
  if (doc.tier === 'archive') return boost.archive;
  return doc.inMemoryIndex ? boost.hotIndexed : boost.hot;
}

function trimSnippet(text, max = RETRIEVAL.snippetChars) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max).replace(/\s\S*$/, '') + '…';
}

/**
 * Hold shelf space for the curated corpus.
 *
 * Applied AFTER ranking, so it never rewrites a score and never promotes a weak
 * document: archive results keep their order and their positions, and the only
 * thing that changes is that they stop past their share, letting the next hot
 * documents through. With no archive tier present this is a no-op, which is why
 * every pre-existing benchmark number is unaffected.
 */
function capArchiveShare(sorted, limit, share = RETRIEVAL.maxArchiveShare) {
  const maxArchive = Math.max(1, Math.floor(limit * share));
  const out = [];
  const held = [];
  let archived = 0;
  for (const row of sorted) {
    if (out.length >= limit) break;
    if (row.tier === 'archive') {
      if (archived >= maxArchive) { held.push(row); continue; }
      archived++;
    }
    out.push(row);
  }
  // If there were not enough hot documents to fill the page, give the space back
  // rather than returning a short result.
  for (const row of held) { if (out.length >= limit) break; out.push(row); }
  return out;
}

/**
 * SOFT TIME ANCHOR. recencyFactor() is this same shape anchored on now; this
 * generalises the anchor to any date, which is what "things from around when
 * that conversation happened" needs.
 *
 * Deliberately a MULTIPLIER, not a filter. A hard window's failure mode is
 * hiding the right answer and saying nothing, so the default tilt must never be
 * able to do that — a document from the wrong month can still win if it is the
 * only real match. Use after/before when you actually mean exclusion.
 */
function nearFactor(modified, anchorMs, halfLifeDays = RETRIEVAL.recency.halfLifeDays, floor = RETRIEVAL.recency.floor) {
  if (!anchorMs) return 1;
  const t = Date.parse(modified);
  if (!Number.isFinite(t)) return 1;
  const days = Math.abs(t - anchorMs) / 864e5;
  return floor + (1 - floor) * Math.pow(0.5, days / halfLifeDays);
}

// A result set that does not say what it CANNOT answer invites the caller to
// over-read it. staleWarning already set the precedent — it names the exact
// command that fixes the staleness — so the same applies to the two mistakes a
// caller actually makes with this corpus:
//   * treating a conversation EXCHANGE as a settled conclusion, when it is a
//     moment in a conversation that may have continued
//   * reading the TOP MATCH as the current state, when relevance ranking cannot
//     distinguish "starting X" from "finished X"
// Both were made here, by me, on the re-parse question. The fix is one call.
// Attach thread position to an exchange row. A FACT, never an alarm: it is either
// exactly right or absent, so it can be shown on every exchange without becoming
// noise the caller learns to skip.
function withThreadPosition(row, idx) {
  const t = idx.threads && idx.threads.get(row.name);
  if (!t) return row;
  row.threadPosition = `${t.position} of ${t.total}`;
  row.laterInThread = t.total - t.position;
  if (t.last !== row.name) row.threadLast = t.last;
  return row;
}

function buildGuidance(results, { scope, query }) {
  const g = [];
  const ex = results.filter((r) => r.type === 'exchange');
  if (ex.length) {
    g.push(`${ex.length} of these are conversation EXCHANGES — a moment in a chat, not a settled ` +
      `conclusion. For "what is the current state", relevance is the wrong axis: call ` +
      `memory({action:"latest", query:"…"}), which filters on terms and orders NEWEST FIRST.`);
    // The conclusion is usually in the exchanges AFTER the one that ranked. Say
    // where it is rather than saying to go looking: 87% of exchanges are >=20
    // deep in a thread, so "there is more" alone is nearly constant and useless.
    // Anchored on the TOP-RANKED mid-thread hit, not the one with the most unread
    // material after it. The failure being prevented is "read the top hit, conclude
    // from it", so the advice has to be about the document that will actually be
    // read -- picking the maximum instead points at a row the caller may never open.
    const mid = ex.filter((r) => r.laterInThread > 0 && r.threadLast);
    if (mid.length) {
      const worst = mid[0];
      g.push(`${mid.length} of these are MID-THREAD — e.g. ${worst.name} is ${worst.threadPosition}, ` +
        `with ${worst.laterInThread} exchanges after it. If you are asking whether something ` +
        `finished, the answer is in one of those, not here: memory({action:"get", name:"${worst.threadLast}"}) ` +
        'is that thread\'s last word.');
    }
    // The "it may have simply stopped" hedge is only honest about a TERMINAL
    // exchange. 97.3% of exchanges are non-terminal, so firing it on all of them
    // would be the cry-wolf failure this file already avoids elsewhere.
    if (ex.some((r) => r.laterInThread === 0)) {
      g.push('Some of these ARE the last exchange of their thread — which means the thread may ' +
        'have concluded, or may simply have STOPPED. Those look identical here; check the world ' +
        '(git log, the filesystem) before reporting one as the other.');
    }
    const sids = [...new Set(ex.map((r) => r.sessionId).filter(Boolean))];
    if (sids.length === 1) {
      g.push('All from one conversation. Its exchanges are ordered by the timestamp suffix ' +
        '(x-<session>-20260903T054233800Z, the ask time) and chained by [[prev]] links, so the thread can be read in sequence.');
    } else if (sids.length > 1) {
      g.push(`Spanning ${sids.length} conversations — check each hit's sessionTitle/account before ` +
        'treating two of them as the same thread.');
    }
  }
  if (scope === 'curated') {
    g.push('scope defaulted to CURATED (hand-written memories). Captured conversations are ' +
      'scope:"staging"; scope:"all" returns both as separate groups.');
    // The library hint rides the same default-scope line, and ONLY when
    // categories actually exist: imported reference material is opt-in by
    // Daniel's rule, so the only honest failure mode left is not knowing it is
    // there to ask for.
    const libs = libraryCorpora();
    if (libs.length) {
      g.push(`${libs.length} library categor${libs.length === 1 ? 'y' : 'ies'} (${libs.join(', ')}) ` +
        "hold imported reference material and are NEVER searched unless named — scope:'" + libs[0] +
        "', an array like ['all','" + libs[0] + "'], or scope:'everything'.");
    }
  }
  return g.length ? g : undefined;
}

/** Enforce RETRIEVAL.maxSlotsPerDoc over an already-sorted result list. */
function capPerDocument(sorted, limit, maxSlots = RETRIEVAL.maxSlotsPerDoc) {
  const seen = new Map();
  const out = [];
  for (const r of sorted) {
    const n = seen.get(r.file) || 0;
    if (n >= maxSlots) continue;
    seen.set(r.file, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}


// ---- retrieval telemetry -------------------------------------------------
// One JSON line per search. This exists so curation can be TARGETED: the
// ablation of 2026-08-17 measured a hand-written description to be worth about
// two rank-1 positions across 101 documents, so rewriting the corpus blind is
// mostly wasted effort. What is worth rewriting is the memory that is actually
// retrieved and actually ranks badly, and nothing could say which until now.
//
// THE ROW IS SCRUBBED HERE, not by its callers. This comment used to read "the payload logged is
// the one already through guardValue()", and that was true of ONE of the four call sites: search's
// main path logs after guardValue, while latest (:2667), thread (:2984) and search's own two
// mode:'empty' rows (:1015, :1036) log the RAW query. So a credential typed as a query landed in
// .query-log.jsonl in plaintext — a file no response guard covers. Measured 2026-09-05 over seven
// invented shapes: 7/7 plaintext on `latest`, 7/7 on the empty-scope rows, 0/7 on `search` proper.
// Redacting inside logQuery makes CALL ORDER irrelevant: a new caller cannot reintroduce this by
// logging before it guards.
// Failure is swallowed — telemetry must never be able to fail a search.
// One caller question = ONE queryId, however many rows fan-out writes.
// Measured on the frozen 2026-08-26/27 window: 180 "live" rows were 26 real
// questions — a multi-scope call logs one row per corpus, and nothing joined
// them, so the log over-reported failure by counting each empty scope as a
// failed query. The id is generated at the public entry and threaded through
// recursion via opts._queryId.
const newQueryId = () => randomUUID().slice(0, 8);

// The log grows without bound (27k rows / 10 MB in its first month). Over the
// cap, the live file rolls to ONE kept generation — never deleted, and the
// pre-fix era is separately preserved in archive-2026-08.query-log.jsonl.
const QUERY_LOG_MAX_BYTES = Number(process.env.MEMORY_QUERY_LOG_MAX_BYTES || 20 * 1024 * 1024);

// THE HANDLER'S OWN LINE. logQuery runs inside lib, after a response is built but before the tool
// handler serialises it, so it cannot know the wire size. Rather than thread a callback down through
// search/latest/sessions, the handler appends ONE lightweight row after `guard(JSON.stringify(...))`
// — same query id as the rows above it, so the analyser joins them; same file, same rotation; lib
// stays unaware of the transport. Never throws.
export function logResponse(row) {
  let path;
  try { path = queryLogPath(); } catch (_) { return; }
  if (!path) return;
  try {
    try {
      if (statSyncFs(path).size > QUERY_LOG_MAX_BYTES) renameSync(path, path.replace(/\.jsonl$/, '.1.jsonl'));
    } catch (_) { /* no file yet */ }
    appendFileSync(path, JSON.stringify({
      ts: new Date().toISOString(), kind: 'response', src: querySource(),
      ...(runId() ? { runId: runId() } : {}),
      ...row
    }) + '\n', 'utf8');
  } catch (_) { /* never fail a response over telemetry */ }
}

function logQuery(payload, extra = {}) {
  let path;
  try { path = queryLogPath(); } catch (_) { return; }
  if (!path) return;
  try {
    try {
      if (statSyncFs(path).size > QUERY_LOG_MAX_BYTES) {
        renameSync(path, path.replace(/\.jsonl$/, '.1.jsonl'));
      }
    } catch (_) { /* no file yet, or the roll lost a race — either way, append */ }
    // Every string this row can carry, through the same redactor the responses use. `scrub`
    // preserves non-strings (an absent query must stay absent, not become '').
    const scrub = (v) => (typeof v === 'string' ? redact(v).text : v);
    const top = (payload.results || payload.bestWeak || []).slice(0, 3)
      .map((r) => ({ name: scrub(r.name), score: r.score, prov: scrub(r.provenance) }));
    appendFileSync(path, JSON.stringify({
      ts: new Date().toISOString(),
      // WHERE THE QUERY CAME FROM. Without this the log is dominated by the
      // suite's own absence probes -- "widget calibration" and "when is the CEO's
      // birthday" are deliberate negative fixtures, and they appeared as the top
      // 5 "real failures" the first time the log was analysed. A report that
      // confident and that wrong is the exact failure this server exists to stop.
      src: querySource(),
      // WHAT was asked matters as much as how the call arrived: eval:state and
      // the gold scorers drive the REAL handler, so their rows are honestly
      // 'live' — the stamp is what lets the analyser exclude them anyway.
      ...(isBenchmarkQuery(payload.query) ? { benchmarkQuery: true } : {}),
      queryId: extra.queryId || newQueryId(),
      // The WRITER's identity (D4), when it declares one. Lets an assertion
      // reason about rows it can prove it produced, instead of every row that
      // happened to land in the same second.
      ...(runId() ? { runId: runId() } : {}),
      // WHO ASKED, when a real MCP request is in flight (lib/config.js beginMcpRequest): the client
      // named in the handshake, the JSON-RPC request id, this process (one per Claude session), and
      // the scope/limit the caller ACTUALLY passed — fan-out rows carry the single expanded corpus in
      // `scope`, so without `requestedScope` an array scope was invisible in the log ("multi-scope
      // live: 0" was an artefact of exactly that). Absent outside a request.
      ...(() => {
        const c = requestContext();
        if (!c) return {};
        return {
          ...(c.client ? { client: c.client } : {}),
          ...(c.procId ? { procId: c.procId } : {}),
          ...(c.requestId !== undefined && c.requestId !== null ? { requestId: c.requestId } : {}),
          ...(c.requestedScope !== undefined ? { requestedScope: c.requestedScope } : {}),
          ...(Number.isFinite(c.limit) ? { limit: c.limit } : {}),
          ...(c.action ? { action: c.action } : {})
        };
      })(),
      // GRAPH SPREAD, WATCHED. Present only when spreading actually changed
      // the top 3 (spreadEffect) or when the mean-normalised shadow would
      // have disagreed (shadowDivergence). Logging only — neither field has
      // ever been read by anything that ranks.
      ...(extra.spreadEffect ? { spreadEffect: extra.spreadEffect } : {}),
      ...(extra.shadowDivergence ? { shadowDivergence: extra.shadowDivergence } : {}),
      scope: payload.scope,
      q: scrub(payload.query),
      mode: payload.mode,
      confidence: payload.confidence,
      noStrongMatch: !!payload.noStrongMatch,
      totalCandidates: payload.totalCandidates,
      // A confidently WRONG top answer used to log exactly like a success.
      // rank1/topScore make wrong-answer analysis possible after the fact.
      rank1: top[0]?.name,
      topScore: top[0]?.score,
      // Row-level failure shape: this SCOPE had nothing at all, vs it had
      // candidates and none was strong. Caller-level verdicts (every scope
      // failed) are derived by the analyser over the queryId group.
      ...(payload.totalCandidates === 0 ? { failKind: 'scope_empty' }
        : (payload.noStrongMatch ? { failKind: 'no_strong_match' } : {})),
      top
    }) + '\n', 'utf8');
  } catch (_) { /* never fail a search over telemetry */ }
}


// Resolve the `account` / `project` filters ONCE, for every action that takes them.
//
// This lived inside search() and latest() re-implemented it from scratch — badly:
// it compared `doc.account !== account` with strict equality, so an ARRAY value
// matched nothing (measured: 27 results as a string, 1 as a one-element array),
// and it never resolved the aliases at all, so `project:'this'` returned 0.
// Two hand-written copies of one rule is exactly how that drifted, so there is
// now one copy and both callers use it.
//
// 'mine' resolves to whatever THIS surface is configured as, so a caller does not
// have to know its own label. 'this' means the project this server is canonically
// pointed at. An unlabelled memory is never filtered out: hiding everything
// written before labelling existed would be a silent loss.
export function resolveFilters({ account = null, project = null } = {}) {
  const toSet = (v, alias) => {
    if (!v) return null;
    const list = (Array.isArray(v) ? v : [v]).map((x) => alias(String(x))).filter(Boolean);
    return list.length ? new Set(list) : null;
  };
  return {
    wantAccounts: toSet(account, (x) => (x === 'mine' ? accountLabel() : x)),
    wantProjects: toSet(project, (x) => (x === 'this' ? basename(dirname(memoryDirPath())) : x))
  };
}

export async function search(query, opts = {}) {
  const {
    limit = RETRIEVAL.defaultLimit,
    includeArchive = true,
    scope = 'curated',       // 'curated' | 'staging' | 'all'
    sessionId = null,        // restrict to one conversation
    account = null,          // 'mine' | a label | array of labels | null = all
    project = null,          // 'this' | a project folder | array | null = all
    after = null, before = null,   // HARD window — excludes
    near = null,                   // SOFT anchor — tilts, hides nothing
    brief = false                  // MEM-86c: rows keep identity, score, snippet — the envelope is untouched
  } = opts;

  // ONE id per caller question, shared by every fan-out row (see logQuery).
  // One id per caller question: the fan-out threads `_queryId`; a real MCP request supplies its own
  // (lib/config.js beginMcpRequest) so the handler's `kind:'response'` row joins every query row.
  const queryId = opts._queryId || requestContext()?.queryId || newQueryId();

  // A multi-corpus scope ('all', 'everything', or an array) searches each
  // corpus against ITS OWN statistics and returns them as separate ranked
  // sections. That is what dissolves the competition problem: measured
  // 2026-08-17, one shared ranked list cost three memories their answer
  // outright, because a transcript of the user discussing a topic outscores the
  // distilled rule for a conversationally-phrased query.
  // 'all' is THE WORK SET (Daniel's rule) — library categories enter only when
  // named, or via 'everything'. See expandScope.
  if (isMultiScope(scope)) {
    const names = expandScope(scope);
    const parts = await Promise.all(names.map((s) => search(query, { ...opts, scope: s, _queryId: queryId, _nested: true })));
    const groups = Object.fromEntries(names.map((s, i) => [s, parts[i]]));

    // PROVENANCE ON THE COMBINED RESPONSE. Each group carries its own
    // indexBuiltAt (they are separate index files, built at different times), so
    // the top level reports the curated one plus the per-scope map — a reader
    // that only looks at the top level still cannot mistake one for the other.
    const builtByScope = Object.fromEntries(names.map((s) => [s, groups[s].indexBuiltAt ?? null]));
    // 🟥 MEM-85 — an EMPTY scope is not a stale one, and the warning NAMES the stale corpus instead
    // of hoisting its sentence over the ones that answered. See aggregateFreshness.
    const fresh = aggregateFreshness(names, (s) => groups[s]);
    const staleAny = fresh.staleAny;
    const staleTotal = fresh.staleFiles;
    // 🟥 MEM-81 — THE STAMP THE GROUPED BUILDERS DROPPED. `configWarning` is stamped on every
    // single-corpus envelope (:270), and its own `effect` text names scope:'everything' as the
    // scope it applies to — yet 'all' and 'everything' were the two scopes that never carried it
    // (Windows acceptance of 1.7.2, F3: PRESENT at curated/staging/default, ABSENT at all/
    // everything). It is aggregate-invariant by construction — one process, one config, so every
    // group computed the identical object — which is exactly why it belongs at the top level and
    // not once per group. Absent when the config is right, like the other conditional stamps.
    const cfgWarnAll = configWarning();
    // The orphan-handoff alarm is HOISTED to the top level. It fires inside
    // groups.handoff.guidance via the recursive call above, but a scope:'all'
    // caller reading only the top-level fields would never see it — and that is
    // most callers, because 'all' is the scope people use when they do not know
    // where something lives. Same cached scan, so this costs nothing extra.
    const topG = (groups.handoff?.guidance || []).filter((l) => l.startsWith('ORPHAN HANDOFF'));
    // HOISTED for the same reader: newer matching store files that a group's ranking could not
    // see. A scope:'all' caller reading only the top level must not miss them.
    const recentUnindexedTotal = names.reduce((a, s) => a + (groups[s].recentUnindexed?.count || 0), 0);
    if (recentUnindexedTotal) {
      topG.push(unindexedGuidance(recentUnindexedTotal, { merged: false }) +
        ' Sections: ' + names.filter((s) => groups[s].recentUnindexed?.count).map((s) => `${s} (${groups[s].recentUnindexed.count})`).join(', ') + '.');
    }
    // The library hint, in the same top-level spot and for the same reader: a
    // scope that expanded to work corpora only, while categories exist, has NOT
    // searched them — say so once rather than let silence read as absence.
    const libs = libraryCorpora();
    const missedLibs = libs.filter((c) => !names.includes(c));
    if (libs.length && missedLibs.length && names.some((n) => CORPORA.includes(n))) {
      topG.push(`${missedLibs.length} library categor${missedLibs.length === 1 ? 'y' : 'ies'} ` +
        `(${missedLibs.join(', ')}) exist and were NOT searched — library content is opt-in by design. ` +
        `Name one (scope:'${missedLibs[0]}') or use scope:'everything' to include them all.`);
    }

    // THE COMPACT EVERYTHING VIEW — scope === 'everything' EXACTLY, never 'all',
    // never an array: those keep today's shape byte-for-byte. Presentation only;
    // every group above was ranked exactly as its named scope ranks.
    let outGroups = groups;
    if (scope === 'everything') {
      const rowCap = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
        ? Math.floor(Number(opts.limit)) : EVERYTHING_VIEW.rowsPerSection;
      const snipCap = Number.isFinite(Number(opts.maxChars)) && Number(opts.maxChars) > 0
        ? Math.floor(Number(opts.maxChars)) : EVERYTHING_VIEW.snippetChars;
      outGroups = compactEverythingGroups(groups, names, { rowCap, snipCap });
      const hint = readTaskHint(query, names);
      if (hint) topG.unshift(hint);
      topG.push(`scope:'everything' is a COMPACT view: up to ${rowCap} row(s) per corpus, ${snipCap}-char ` +
        'snippets, diagnostic fields dropped, per-group boilerplate said once here. These are DEFAULTS, not ' +
        'ceilings — limit:/maxChars: raise them, and naming a scope returns its full section. Each ' +
        'trimmed section carries its own compactNote with the counts.');
      if (names.some((s) => (outGroups[s]?.bestWeak || []).length)) {
        topG.push('Sections flagged noStrongMatch hold NEAREST NEIGHBOURS under bestWeak, not ranked answers — ' +
          'do not report one as a memory of the thing asked on the strength of its rank; if a snippet looks ' +
          'like the answer, open its section and verify before quoting it. The full absence verdict is in the named scope.');
      }
      return refuseGlobalNoIndexClaim({
        query, scope,
        guidance: topG,
        indexBuiltAt: builtByScope.curated ?? builtByScope[names[0]] ?? null,
        indexBuiltAtByScope: builtByScope,
        indexStale: staleAny,
        staleFiles: staleAny ? staleTotal : 0,
        staleWarning: fresh.staleWarning,
        ...(cfgWarnAll ? { configWarning: cfgWarnAll } : {}),
        ...(brief ? { briefNote: BRIEF_NOTE } : {}),
        // Said once, instead of once per group.
        modifiedFieldNote: "each result's `modified` is that file's mtime AT INDEX TIME, not a live stat — memory({action:'get'}) returns a live one",
        serverVersion: serverVersionString(),
        serverStartedAt: SERVER_STARTED_AT,
        groups: outGroups,
        // The flat back-compat array would DUPLICATE every group row here, and
        // duplication was a third of the oversized response. In the compact
        // view it is a directory — name, corpus, score — not a second copy.
        results: names.flatMap((s) => (outGroups[s].results || []).map((r) => ({ name: r.name, corpus: s, score: r.score }))),
        resultsNote: 'results is a DIRECTORY of the group rows (name/corpus/score) — the rows themselves are under groups.<corpus>.',
        noStrongMatch: names.every((s) => groups[s].noStrongMatch)
      }, "search scope:'everything'");
    }

    // ---- MEM-86 — THE ROWS ARE SERIALIZED ONCE, AND A ZERO-ROW SECTION STOPS COSTING 6 KB ----
    //
    // Measured byte by byte on the same 2026-09-07 payload — a 56,550-byte response for ten
    // results, which overflowed the tool-result limit and had to be read back off disk with Python:
    //
    //   10 result objects under groups.staging.results      13,558 B   30 %
    //   the SAME ten, BYTE-IDENTICAL, in top-level results  13,558 B   30 %
    //   three zero-row sections' boilerplate                13,372 B   30 %
    //     curated 6,317 (bestWeak alone 3,909) · handoff 5,819 · projects 1,236
    //   everything else                                      4,400 B   10 %
    //
    // name + score + snippet for all ten rows would have been 4,054 characters.
    //
    // (a) BOTH COPIES EXIST FOR A REASON — the flat array is what most callers read, the section is
    //     where the honesty fields live — so neither is deleted: the SECTION points at the copy
    //     that is already in the response. Only when every one of that section's rows survived the
    //     flat array's slice; a section whose rows were cut cannot delegate to a list without them.
    // (b) A CORPUS THAT RANKED NOTHING, in a response where another corpus did, does not need its
    //     whole absence apparatus. `bestWeak` is the fallback for "nothing ANYWHERE", and
    //     `absenceNote` is the same paragraph in every such section. Names and scores are enough to
    //     decide whether to open one, and the named scope still returns the entire verdict. When
    //     NOTHING hit anywhere the fallback IS the answer, so both stay in full — that is the
    //     control, and it is asserted.
    //
    // Neither half touches ranking, a score, or an order: `groups` above is what it was, and the
    // rows are the same objects. This is what the response is MADE OF, not what it says.
    const flatRows = names.flatMap((s) => (groups[s].results || []).map((r) => ({ ...r, corpus: s })))
      .slice(0, limit * names.length);
    const flatKept = {};
    for (const r of flatRows) flatKept[r.corpus] = (flatKept[r.corpus] || 0) + 1;
    const anyScopeHit = names.some((s) => (groups[s].results || []).length > 0);
    const weakCapped = [];
    const outGroupsAll = {};
    for (const s of names) {
      const g = groups[s];
      const n = (g.results || []).length;
      let g2 = g;
      if (n > 0 && flatKept[s] === n) {
        const { results: _sameRowsAtTopLevel, ...rest } = g;
        g2 = { ...rest, resultsRef: 'results', count: n,
          resultsRefNote: `these ${n} row(s) are the top-level \`results\` entries with corpus:'${s}', in this order.` };
      }
      if (anyScopeHit && n === 0) {
        g2 = { ...g2 };
        if (Array.isArray(g2.bestWeak) && g2.bestWeak.length) {
          g2.bestWeak = g2.bestWeak.slice(0, WEAK_CAP_WHEN_ANOTHER_HIT).map((r) => ({ name: r.name, score: r.score }));
          weakCapped.push(s);
        }
        delete g2.absenceNote;
      }
      // Said once (see GROUP_SAID_ONCE). Done last so the two rules above read on the real section.
      if (GROUP_SAID_ONCE.some((k) => k in g2)) {
        g2 = { ...g2 };
        for (const k of GROUP_SAID_ONCE) delete g2[k];
      }
      outGroupsAll[s] = g2;
    }
    if (weakCapped.length) {
      const one = weakCapped.length === 1;
      topG.push(`NEAREST NEIGHBOURS TRIMMED (${weakCapped.join(', ')}): ` +
        `${one ? 'that corpus' : 'those corpora'} ranked nothing strongly while another corpus answered, so ` +
        `${one ? 'its' : 'their'} \`bestWeak\` rows carry NAMES AND SCORES only and ${one ? 'its' : 'their'} ` +
        'absence note was dropped — the same paragraph in every empty section was a third of an oversized ' +
        'response. These are NOT ranked answers and a score here settles nothing: read one with ' +
        'memory({action:"get", name, brief:true}), or call the corpus by name ' +
        `(scope:'${weakCapped[0]}') for the full absence verdict, its reasoning and the snippets.`);
    }

    return refuseGlobalNoIndexClaim({
      query, scope,
      ...(topG.length ? { guidance: topG } : {}),
      indexBuiltAt: builtByScope.curated ?? builtByScope[names[0]] ?? null,
      indexBuiltAtByScope: builtByScope,
      indexStale: staleAny,
      staleFiles: staleAny ? staleTotal : 0,
      staleWarning: fresh.staleWarning,
      ...(cfgWarnAll ? { configWarning: cfgWarnAll } : {}),
      serverVersion: serverVersionString(),
      serverStartedAt: SERVER_STARTED_AT,
      ...(recentUnindexedTotal ? { recentUnindexedTotal } : {}),
      ...(brief ? { briefNote: BRIEF_NOTE } : {}),
      // Said HERE instead of in all four sections — the wording AGGREGATED_AS has claimed since
      // this note existed, and which scope:'all' did not honour.
      modifiedFieldNote: "each result's `modified` is that file's mtime AT INDEX TIME (see indexBuiltAtByScope), not a live stat — memory({action:'get'}) returns a live one",
      groups: outGroupsAll,
      // Back-compat, and since MEM-86 the ONLY copy: a caller that only reads .results still gets
      // something sensible, curated first, and each row says which corpus it came from.
      results: flatRows,
      ...(names.some((s) => outGroupsAll[s].resultsRef) ? { resultsNote:
        'every group row appears here ONCE, stamped with its `corpus`; a section showing `resultsRef` ' +
        'has its rows in this array (MEM-86).' } : {}),
      noStrongMatch: names.every((s) => groups[s].noStrongMatch)
    }, `search scope:${JSON.stringify(scope)}`);
  }

  const { wantAccounts, wantProjects } = resolveFilters({ account, project });

  const anchorMs = near ? Date.parse(near) : null;
  const afterMs = after ? Date.parse(after) : null;
  const beforeMs = before ? Date.parse(before) : null;

  // CHECK THE INDEX AGAINST THE CORPUS BEFORE ANSWERING FROM IT. This may
  // rebuild incrementally, in which case `idx` below is the fresh one.
  const { idx, stamp } = await ensureFresh(scope);
  if (!idx.present) {
    // A SECONDARY corpus with no index is empty, not broken: it may simply be
    // switched off. Saying `noStrongMatch` keeps a scope:'all' verdict honest —
    // without it, an absent handoff index read as "something matched".
    // The orphan alarm still fires here: "no handoff index AND a handoff file
    // is sitting one level below a root" is the emptiest possible corpus hiding
    // the very document being asked for.
    if (scope !== 'curated') {
      const orphanG = scope === 'handoff' ? orphanHandoffLines() : [];
      const out = { query, scope, mode: 'empty', results: [], noStrongMatch: true, ...stamp,
        ...(orphanG.length ? { guidance: orphanG } : {}) };
      // An empty scope is an ANSWERED question ("this corpus had nothing"),
      // and the caller-level analyser needs the row to say so: without it, a
      // fan-out over eight corpora logged only the non-empty ones and the
      // queryId group under-counted its own scopes.
      logQuery({ ...out, totalCandidates: 0 }, { queryId });
      return out;
    }
    return { mode: 'unavailable', error: idx.corrupt
      ? 'the index file exists but is unreadable (truncated or corrupt) — a rebuild has been started; retry shortly, or run `npm run index` (or memory({action:"index"}))'
      : 'no index — run `npm run index` (or memory({action:"index"}))', results: [], ...stamp };
  }

  // PRESENT BUT EMPTY is a real state, and it is the FIRST state every new install
  // is in: `npm run index` on a machine with no memories yet writes a perfectly
  // valid index containing zero documents. `present` is then true while `bm25` is
  // null, because buildBm25 is skipped for an empty corpus (see loadScope) — and
  // every search threw "Cannot read properties of null (reading 'postings')".
  //
  // Found by installing the zip on a clean HOME and running the stdio check, which
  // is the only place this could have shown up: no developer machine is ever empty.
  if (!idx.docs.length) {
    const out = {
      query, scope, mode: 'empty', results: [], noStrongMatch: true, ...stamp,
      note: 'This corpus has an index but NO DOCUMENTS in it. On a new install that is ' +
        'expected until memories are written or a conversation is captured — nothing is ' +
        'broken, and there is nothing to find yet.'
    };
    logQuery({ ...out, totalCandidates: 0 }, { queryId });   // same reason as the no-index row above
    return out;
  }

  const docs = idx.docs;
  const model = idx.bm25;

  // ---- D5: IS THIS A READ TASK? Asked for EVERY scope, not just 'everything'.
  // readTaskHint() handled this correctly from the day it was written and was
  // only ever called inside the scope:'everything' branch, so a named library
  // scope asking "summarize <a document this corpus holds>" got a refusal and
  // no hint. Computed here because the second half of the fix (flag-gated
  // below) needs it before the term statistics are taken.
  const readHint = readTaskHint(query, [scope]);
  const readVerb = READ_VERB_RE.exec(String(query || ''));

  // ---- keyword side (normalised below, once we know whether we are fusing) ----
  const { scores: rawKw, matchedTerms } = bm25Search(model, query);
  // THE READ VERB IS NOT A MISSING SUBJECT (D5, flag MEMORY_READ_VERB_WEIGHT).
  // `summarize` appears in no document, so it was charged as evidence that the
  // corpus lacks what was asked for — 49% of one observed query's
  // discriminative weight. Only when the hint actually fired, and only the
  // matched verb text: the keyword and semantic legs still read the whole
  // question, and a query about a "summary section" is untouched because the
  // hint does not fire on it.
  const stripVerbWeight = readVerbWeightEnabled() && readHint && readVerb;
  const stats = queryTermStats(model,
    stripVerbWeight ? String(query).slice(readVerb[0].length) : query);

  // ---- PHASE 4a: model -> family expansion, keyword leg only ---------------
  // A question about ACME-673A is a question about the ACME-x73A manual. The
  // 🟥 THE SKU/MODEL FAMILY-ALIAS LAYER WAS REMOVED HERE (2026-09-03). It expanded a query like
  // "ACME-x73" into sibling model stems as a separate, lower-weighted keyword pass.
  //
  // Removed because it earned nothing, RE-DERIVED before removing rather than taken on trust:
  // `node scripts/measure-sku-alias.js` against the frozen pre-registered set gives
  //   targets improved 0/12   control regressions 0/12   BAR: >=8 improved -> MISSED
  // It had been off by default ever since, so this removal cannot change a shipped result -- proved
  // by snapshotting 46 real queries (ranked names + score + keywordScore to 6dp) before and after:
  // byte-identical.
  //
  // It also had a public-tree defect: lib/aliases.js SHIPPED while its generated data file
  // lib/alias-table.json was excluded, so a stranger got a module reading a file that was not there.
  //
  // `rawKwUnexpanded` survives as a plain alias of `rawKw` because the absence verdict is
  // deliberately computed on the caller's own words; keeping the name keeps that intent legible if
  // a future expansion layer is ever added back.
  const rawKwUnexpanded = rawKw;

  // ---- semantic side ----
  const sem = new Map();
  const bestChunk = new Map();
  let mode = 'bm25-only';
  let degradedReason = idx.headerProblems.length
    ? `index header refused: ${idx.headerProblems.join('; ')}`
    : embeddingsDisabledReason();

  if (idx.dense) {
    const qvec = await embedQuery(query);           // QUERY: prefix applied.
    if (qvec) {
      mode = 'hybrid';
      degradedReason = null;
      docs.forEach((doc, i) => {
        let best = -1, bestText = null;
        for (const c of doc.chunks || []) {
          if (!isVec(c.vec)) continue;
          const s = cosine(qvec, c.vec);
          if (s > best) { best = s; bestText = c.text; }
        }
        // The doc-level summary vector competes on equal footing, so a
        // three-line standing rule can out-rank a 60-chunk runbook.
        if (isVec(doc.summaryVec)) {
          const s = cosine(qvec, doc.summaryVec);
          if (s > best) { best = s; bestText = bestText || doc.description; }
        }
        const scaled = rescaleCosine(best);
        if (scaled > 0) { sem.set(i, scaled); bestChunk.set(i, bestText); }
      });
    } else {
      degradedReason = embeddingsDisabledReason() || 'query embedding failed';
    }
  }

  // ---- normalise the keyword leg ----
  // Fusing: the score has to mean the same thing on every query, so it is
  // measured against an absolute scale. Not fusing: nothing to be compared
  // against, so keep the historical per-query-max form.
  const kw = mode === 'hybrid' ? absoluteKeyword(rawKw, stats) : normalise(rawKw);
  // With no expansion layer there is nothing to subtract, so the "as asked" leg IS the leg.
  const kwUnexpanded = kw;

  // ---- fuse, pass 1: keyword + (length-corrected) semantic ----
  const { keyword: wk, semantic: ws, phrase: wp } = RETRIEVAL.fuse;
  const candidates = new Set([...kw.keys(), ...sem.keys()]);
  const pass1 = [];
  for (const i of candidates) {
    const doc = docs[i];
    if (!includeArchive && doc.tier === 'archive') continue;
    // HARD filters: these EXCLUDE, so they are only ever applied when asked for.
    if (sessionId && doc.sessionId !== sessionId) continue;
    if (wantAccounts && doc.account && !wantAccounts.has(doc.account)) continue;   // accountFilter
    if (wantProjects && doc.project && !wantProjects.has(doc.project)) continue;
    if (afterMs || beforeMs) {
      const t = Date.parse(doc.modified);
      if (Number.isFinite(t)) {
        if (afterMs && t < afterMs) continue;
        if (beforeMs && t > beforeMs) continue;
      }
    }
    const k = kw.get(i) || 0;
    const rawSem = sem.get(i) || 0;
    // PHASE B -- A SECTION IS PENALISED AS ITS PARENT.
    //
    // longDocFactor exists because scoring a document by the MAXIMUM over its
    // chunks lets a 517-chunk document beat a 3-chunk one on volume alone.
    // Splitting that document into sections hands the advantage straight back
    // through the side door: 138 changelog sections are 138 small documents,
    // each individually short enough to escape the penalty entirely.
    //
    // Measured before this correction: the changelog took a top-3 slot on 20 of
    // 32 probes, up from 0. Recall fell 10/10 -> 9/10 and MRR 0.833 -> 0.683 --
    // almost exactly the staging-blend regression (0.826 -> 0.681) the plan
    // warned that this class of change reproduces.
    //
    // A child is therefore scored with its PARENT'S chunk count, summed over
    // every doc sharing the file. A section of a huge document is still part of
    // a huge document, and the correction has to see it that way.
    const ownChunks = (doc.chunks || []).length;
    const nChunks = doc.parentName
      ? sectionEffectiveChunks(ownChunks, chunksByFile(idx).get(doc.file) || ownChunks)
      : ownChunks;
    const ldf = mode === 'hybrid'
      ? longDocFactor(nChunks, idx.referenceChunks, k, doc.parentName ? sectionWaiver() : undefined)
      : 1;
    const s = rawSem * ldf;
    const base = mode === 'hybrid' ? wk * k + ws * s : k;
    if (base <= 0) continue;
    pass1.push({ i, doc, k, s, rawSem, ldf, base });
  }
  pass1.sort((a, b) => b.base - a.base);

  // ---- fuse, pass 2: the phrase leg, over the rerank set only ----
  // Everything below the rerank set keeps phrase = 0, which is what it would
  // almost certainly have scored anyway: the leg only fires on a document that
  // holds the query's words side by side, and such a document is not sitting at
  // rank 40 on the other two legs.
  const rerankTo = Math.min(pass1.length, Math.max(RETRIEVAL.rerankSet, limit));
  let topPhrase = 0;
  for (let n = 0; n < rerankTo; n++) {
    const row = pass1[n];
    const win = matchedTerms.length ? bestWindow(row.doc, matchedTerms) : null;
    row.phrase = win ? win.phrase : 0;
    row.window = win;
    if (row.phrase > topPhrase) topPhrase = row.phrase;
    row.base = mode === 'hybrid' ? wk * row.k + ws * row.s + wp * phraseContribution(row.phrase) : row.k;
  }

  const scored = [];
  // Kept as an empty map: the absence verdict falls back to `top.score` when a name is absent from
  // it, which with no expansion layer is always. Removing the parameter would touch absenceVerdict's
  // signature and its tests for no behavioural gain.
  const aliasFreeScore = new Map();
  for (const row of pass1) {
    const { doc, k, s, base } = row;
    const phrase = row.phrase || 0;
    const envelope = tierBoost(doc) * recencyFactor(doc.modified) * nearFactor(doc.modified, anchorMs);
    const score = base * envelope;
    const provenance = k > 0 && s > 0.35 ? 'both' : (k > 0 ? 'keyword' : (phrase > 0.2 ? 'phrase' : 'semantic'));
    // Snippet: the phrase window decides where to cut whenever the keyword leg
    // found anything at all — that is what makes a verbatim search return the
    // sentence rather than the top of the document. Only a purely semantic hit
    // falls back to the best-matching chunk.
    let snippet;
    if (row.window) snippet = snippetAround(bodyOf(doc), row.window.charStart, row.window.charEnd);
    else snippet = trimSnippet(bestChunk.get(row.i) || doc.description);
    scored.push({
      name: doc.name,
      file: doc.file,
      // WHICH CORPUS answered. scope:'all' used to be the only response that said
      // so, which made a single-scope row ambiguous the moment there was more
      // than one corpus holding hot, writable, project-stamped memories.
      corpus: scope,
      description: doc.description,
      tier: doc.tier,
      inMemoryIndex: doc.inMemoryIndex,
      type: doc.type,
      // attribution travels WITH the hit: a caller that can filter by account
      // but cannot see it has to guess where an answer came from.
      account: doc.account || null,
      project: doc.project || null,
      sessionId: doc.sessionId || null,
      sessionTitle: doc.sessionTitle || null,
      ...(doc?.inFlight ? { inFlight: true, inFlightNote: 'This exchange was STILL BEING WRITTEN when it was captured — the assistant had not finished replying. Treat it as a draft, not the last word; the finished version replaces it on the next capture.' } : {}),
      // WHERE this came from. For a handoff document the folder is the whole
      // provenance story — its file id is only a namespaced basename.
      path: doc.sourcePath || null,
      readOnly: !!doc.readOnly,
      // THE FILE'S MTIME AT INDEX TIME, not a live stat. Read as a live value on
      // 2026-08-19 it produced a confidently wrong conclusion about project
      // state, which is why `indexBuiltAt` and `modifiedFieldNote` are stamped
      // on every response. memory({action:"get"}) returns a live mtime.
      modified: doc.modified,
      score: Number(score.toFixed(4)),
      keywordScore: Number(k.toFixed(4)),
      semanticScore: Number(s.toFixed(4)),
      phraseScore: Number(phrase.toFixed(4)),
      provenance,
      snippet,
      links: doc.links
    });
  }
  scored.sort((a, b) => b.score - a.score);
  // capPerDocument first, over the WHOLE ranked list: capArchiveShare has to be
  // able to reach past a run of archive hits to find the hot documents it is
  // holding space for, and a pre-truncated pool cannot (measured: a limit*3 pool
  // was already 7/9 archive, so the giveback path handed the slots straight back).
  // THE PER-FILE CAP DOES NOT FIT A LIBRARY CORPUS. capPerDocument counts slots
  // by r.file so a parent and its children never pose as independent evidence —
  // correct where a corpus holds hundreds of files. A library category is often
  // ONE file: the first manual question measured returned exactly one row (the
  // parent nav stub) because every page section shares the manual's file, so no
  // section could ever reach the caller. Three sections of the same manual ARE
  // the answer there. Work corpora keep the cap unchanged (a48 pins that).
  const perDocCap = isLibraryCorpus(scope) ? Infinity : undefined;
  const shapeRows = (rows) => capArchiveShare(capPerDocument(rows, rows.length, perDocCap), limit)
    .map((r) => withThreadPosition(r, idx));
  // THE PRE-SPREAD RANKING IS KEPT. The absence verdict is judged on it
  // (Phase 4c): spreading may reorder what the query reached, never turn a
  // refusal into an answer — the same rule Phase 4a's expansion obeys.
  const resultsPreSpread = shapeRows(scored);
  let results = resultsPreSpread;
  let graphSpreadInfo = null;
  let spreadEffectRow = null, shadowRow = null;

  // ---- PHASE 4c: gated spreading over the hand-authored [[wiki-link]] graph
  // Curated only, single hop, from the pre-spread scores, and only onto
  // documents the query already reached that clear the similarity gate.
  if (graphSpreadEnabled() && scope === 'curated') {
    const byName = new Map(idx.docs.map((d) => [d.name, d]));
    const linksOf = (name) => {
      const d = byName.get(name);
      return d ? { links: d.links || [], backlinks: d.backlinks || [] } : null;
    };
    const { rows: spreadRows, spread } = applyGraphSpread(scored, linksOf);
    if (spread.length) {
      results = shapeRows(spreadRows);
      // TELEMETRY, NOT PAYLOAD. Both of these go to the query log and nowhere
      // near `out` — a caller's bytes do not change because watching is on.
      spreadEffectRow = spreadEffect(resultsPreSpread, results);
      // 🟥 LIVE TRAFFIC ONLY. Measured 2026-09-04 against the real query log: of 2,210 rows
      // carrying shadowDivergence, 2,210 came from src:"test" and ZERO from src:"live". The
      // graph-spread shadow had never once observed a real query, so any conclusion drawn from it
      // would have been a statement about this project's own test suite.
      //
      // Same defence lib/ordinary-shadow.js:115 already carries, for the same reason: `src` records
      // HOW a call arrived, independently of what it asked, so it excludes the suite whatever the
      // suite happens to ask. A what-was-asked filter alone is not enough — that is exactly how the
      // other probe got poisoned.
      //
      // Computed only when it will be kept; computing then dropping at log time would spend the
      // work 99.5% of the time for nothing.
      shadowRow = querySource() === 'live'
        ? shadowDivergence(scored, linksOf, results,
            { alpha0: spreadAlpha(), docs: idx.docs, shape: shapeRows })
        : null;
      graphSpreadInfo = { received: spread.length,
        note: 'GRAPH SPREAD: some results were lifted by the [[wiki-link]]s a person wrote between ' +
          'these memories — a linked neighbour of a strong hit, which also matched the question on ' +
          'its own. The absence verdict was computed BEFORE any of this.' };
    }
  }

  // VERIFICATION BELONGS HERE MOST OF ALL. attachCommits was wired into latest()
  // and thread() and not into search() -- and the query log says search is 98.4%
  // of real traffic, so the check that turns a claim into a fact was missing from
  // the action almost everyone actually calls. Same batch, same cache: one git
  // process for the whole response, nothing when MEMORY_GIT_REPOS is unset.
  const byNameForCommits = new Map(idx.docs.map((d) => [d.name, d]));
  await attachCommits(results, results.map((r) => bodyOf(byNameForCommits.get(r.name)) || ''));

  // ---- the absence verdict ----
  // THE VERDICT IS COMPUTED ON THE QUESTION AS ASKED. Both of its inputs are
  // handed over unexpanded (Phase 4a): the raw keyword mass, and — through
  // aliasFreeScore — the top document's score. Expansion can move what ranks;
  // it can never turn "I have no memory of that" into an answer.
  const verdict = absenceVerdict({ results: resultsPreSpread, topPhrase, rawKw: rawKwUnexpanded, stats, mode, aliasFreeScore, scope });
  // Refusals keep their empty list; an answered query is answered with the
  // spread ordering. Nothing here can create or destroy a refusal.
  if (verdict.results && verdict.results.length) verdict.results = results;

  // CORPUS CURRENCY, ON THE ACTION PEOPLE ACTUALLY USE. corpusCurrency fired
  // only from latest() while ~95% of real traffic is search — the f2fffdd
  // defect class (verification wired into the paths the author was thinking
  // about) for the third time. Cached with a TTL because search volume is what
  // latest never had: one rev-list bundle per corpus state per minute, not per
  // query. Silent no-op without MEMORY_GIT_REPOS, exactly like latest.
  let currency = null;
  try {
    currency = idx.newestTs ? await cachedCorpusCurrency(new Date(idx.newestTs).toISOString()) : null;
  } catch (_) { currency = null; }

  // C2 -- awaited HERE because the guidance below is assembled synchronously.
  // Cached and time-boxed in git-join; a no-op without MEMORY_GIT_REPOS.
  const autoIdent = await autoVerifyQuery(query);

  // THE STORE IS TRUTH, BESIDE THE RANKING — NEVER IN IT. Files the index has not read yet are
  // opened directly (lib/unindexed.js) and, when they share at least one term with the question,
  // listed under `recentUnindexed`. They are NOT scored and NOT merged into `results`: search is a
  // ranker, and a document with no BM25 statistics and no vector cannot be ranked honestly against
  // ones that have both. So the ranked list is byte-identical to what it was, and the caller is
  // told, in a field it can branch on, that newer matching files exist and where they are.
  const direct = readUnindexed(stamp);
  let recentUnindexed = null;
  if (direct.total) {
    const qTokens = new Set(tokenize(query));
    const rawWords = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];
    const matching = direct.docs.filter((d) => {
      const dTokens = tokenize(d.name + ' ' + (d.description || '') + ' ' + bodyOf(d));
      return dTokens.some((t) => qTokens.has(t));
    }).sort((a, b) => (Date.parse(b.ts || b.modified || 0) || 0) - (Date.parse(a.ts || a.modified || 0) || 0));
    recentUnindexed = {
      count: matching.length,
      files: matching.slice(0, 5).map((d) => {
        const body = bodyOf(d);
        const hay = body.toLowerCase();
        const w = rawWords.find((x) => hay.includes(x));
        const i = w ? hay.indexOf(w) : -1;
        return {
          name: d.name, file: d.file, description: d.description,
          ts: d.ts || d.modified || null,
          ...(d.inFlight ? { inFlight: true } : {}),
          snippet: guardValue(trimSnippet(i >= 0 ? snippetAround(body, i, i + w.length) : body), 'recent-unindexed-snippet')
        };
      }),
      scanned: direct.scanned, total: direct.total,
      ...(direct.excluded ? { excluded: direct.excluded } : {}),
      ...(direct.truncated ? { truncated: true } : {}),
      ...(direct.enabled ? {} : { disabled: 'MEMORY_UNINDEXED_DIRECT=0' })
    };
  }

  const out = guardValue({
    query,
    scope,
    mode,
    // WHEN was this index built, WHICH build of the server answered, and is the
    // index still level with the corpus. Additive: no existing field moved.
    ...stamp,
    degradedReason: degradedReason || undefined,
    matchedTerms,
    unmatchableTerms: stats.absent.length ? stats.absent : undefined,
    // The STRUCTURED half of F1: the guidance line above is prose a caller has to
    // read; this is the field it can branch on, mirroring latest().
    ...(() => {
      const u = staleTermCollision(stats.absent, stamp) ? null : staleContentScan(stats.absent, stamp);
      if (!u) return {};
      // scanTruncated rides alongside: a caller branching on foundInUnindexed being empty
      // must be able to tell "we looked everywhere and found nothing" from "we ran out of
      // budget" — opposite conclusions from the same empty object.
      return { foundInUnindexed: u.foundInUnindexed,
               ...(u.scanTruncated ? { scanTruncated: u.scanTruncated } : {}) };
    })(),
    totalCandidates: scored.length,
    ...verdict,
    // Newer store files the ranking could not see (present only when the check found something —
    // a current index leaves this response byte-identical to before).
    ...(recentUnindexed ? { recentUnindexed } : {}),
    guidance: (() => {
      const g = buildGuidance(verdict.results || verdict.bestWeak || [], { scope, query }) || [];
      // Same diagnosis as latest(): an unmatchable term that names a file the
      // staleness check just flagged is a STALE INDEX, not an absence.
      const c = staleTermCollision(stats.absent, stamp);
      // 🟥 F1 (2026-08-30). The FILENAME pass above was already here; the CONTENT
      // pass was not — it only ever lived in latest(). So the motivating incident was
      // alive in this sibling API: the five cases where lib/freshness.js REFUSES an
      // inline repair (>8 files changed, embedder unavailable, a failed rebuild inside
      // the cooldown, a header change, and staging which never repairs inline by
      // design) all leave search() answering from a stale index — able to imply
      // absence while its own staleWarning names the file holding the answer.
      // Runs only when the filename pass found nothing AND a term is still
      // unmatchable, exactly as latest() does, so a fresh index does no extra work.
      const unindexedHere = c ? null : staleContentScan(stats.absent, stamp);
      const pre = [];
      // FIRST when it fires: newer matching files exist that this ranking cannot see.
      if (recentUnindexed && recentUnindexed.count) pre.push(unindexedGuidance(recentUnindexed.count, { merged: false }));
      if (unindexedHere) pre.push(unindexedHere.note);
      // FIRST, when it fires: it reframes the entire response. A caller told
      // "these are fragments, read the document instead" does not need to be
      // talked out of the absence note first.
      if (readHint) pre.push(readHint);
      if (c) pre.push(c);
      if (autoIdent) pre.push('NOT IN THE CODE — ' + autoIdent.note);
      // THE SMOKE ALARM. A handoff document one level below a root matches the
      // patterns and is indexed by nothing (the scan is flat by design), which
      // is invisible everywhere except here — the moment someone queries the
      // handoff corpus and might conclude "no handoff exists". Cached with a
      // short TTL in lib/orphan-handoffs.js, so this is not a readdir per query.
      if (scope === 'handoff') pre.push(...orphanHandoffLines());
      // Fires only when there IS a gap — the same say-it-when-true rule the
      // last-word caveat follows. A zero-commit confirmation is a field, not
      // a guidance line.
      if (currency && currency.commitsSince.some((r) => r.commitsSince > 0)) pre.push(currency.note);
      return pre.length ? [...pre, ...g] : (g.length ? g : undefined);
    })(),
    ...(currency ? { corpusCurrency: currency } : {}),
    // SAY WHEN A QUESTION WAS BROADENED. A caller who asked about one model
    // and is handed a family manual deserves to know which word did that.
    ...(graphSpreadInfo ? { graphSpread: graphSpreadInfo } : {}),
    identifiersNotInCode: autoIdent ? autoIdent.identifiersNotInCode : undefined
  }, 'search-output');
  logQuery(out, { queryId, spreadEffect: spreadEffectRow, shadowDivergence: shadowRow });
  // MEM-86c, AFTER the telemetry row on purpose — see briefRows.
  return brief ? briefRows(out, { top: !opts._nested }) : out;
}

// One rev-list bundle per (corpus newest-timestamp, repo set) per TTL window.
// latest() could afford a per-call git spawn; search cannot — it is ~95% of
// traffic and the everything scope fans out to eight corpora per question.
const CURRENCY_CACHE = new Map();   // key -> { at, value }
const currencyTtlMs = () => Number(process.env.MEMORY_CURRENCY_TTL_MS || 60000);
async function cachedCorpusCurrency(sinceIso) {
  const key = `${sinceIso}|${configuredRepos().map((r) => r.dir).join(':')}`;
  const hit = CURRENCY_CACHE.get(key);
  if (hit && Date.now() - hit.at < currencyTtlMs()) return hit.value;
  const value = await corpusCurrency(sinceIso);
  CURRENCY_CACHE.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Can the server say "I have no memory of that"?
 *
 * Only when all three independent weaknesses coincide (see RETRIEVAL.absence
 * for the measured constants and why a single score threshold cannot work):
 * nothing scored well, the query's words never occur together anywhere, and —
 * once the words that exist nowhere in the corpus are charged for — most of the
 * question went unanswered.
 *
 * The results are still returned, under `bestWeak`, because "nothing strong,
 * but here is the nearest thing" is more useful than an empty array and lets
 * the caller overrule the verdict. What changes is the label: a caller that
 * sees `noStrongMatch: true` must not report the top hit as an answer.
 */
function absenceVerdict({ results, topPhrase, rawKw, stats, mode, aliasFreeScore = null, scope = null }) {
  // PER CORPUS, not per server. A floor calibrated on curated and applied to a
  // one-book library category does not measure absence, it measures the
  // corpus — see lib/absence-floors.js. Falls back to the shipped constants
  // for any corpus with no derived profile.
  const { scoreFloor, phraseFloor, coverageFloor, orphanFloor, weakResults } = floorsFor(scope);
  const top = results[0];
  if (!top) {
    return {
      noStrongMatch: true, confidence: 'none', results: [], bestWeak: [],
      absenceNote: 'No document matched any term of this query and no passage was semantically close. Treat as absent from memory.'
    };
  }
  // The absence rule is calibrated on the fused three-leg score. In degraded
  // (bm25-only) mode there is no dense leg and the keyword score is per-query
  // normalised, so the constants do not apply — never claim absence there.
  if (mode !== 'hybrid') return { confidence: 'unrated', results };

  let bestRaw = 0;
  for (const v of rawKw.values()) if (v > bestRaw) bestRaw = v;
  const strictCoverage = stats.idealFull > 0 ? bestRaw / stats.idealFull : 0;
  // PHRASE EVIDENCE COUNTS IN PROPORTION TO WHAT IT COVERS. bestWindow computes
  // adjacency over the MATCHED terms only, so a query whose one discriminative
  // term is an orphan can still score topPhrase 1.0 on the ordinary words left
  // over — measured on the library corpus: "warranty period of the Zentrifax
  // burner" hit phrase 1.0 ("warranty period", adjacent in GPL boilerplate)
  // with orphanShare 0.83 and lexical coverage 0.06, and the phrase guard
  // blocked BOTH absence routes. A perfect phrase over 6% of the question is
  // not the verbatim-quote case the guard exists for: a real quote carries its
  // coverage with it. So the guard reads the phrase DISCOUNTED by how much of
  // the question the document answers lexically — a full-coverage phrase is
  // untouched, a residue phrase shrinks to what it actually proves.
  const effPhrase = topPhrase * Math.min(1, strictCoverage / coverageFloor);
  // THE SCORE THE VERDICT JUDGES ON is the one the caller's own words earned.
  // With family expansion on, top.score contains borrowed keyword mass, and
  // judging absence on it would let expansion overturn a refusal — the one
  // thing the layer is forbidden to do.
  const topScore = (aliasFreeScore && aliasFreeScore.has(top.name)) ? aliasFreeScore.get(top.name) : top.score;
  // The three numbers the verdict is made of, always reported: a surprising
  // verdict should be as diagnosable as a surprising rank.
  const signals = {
    topScore: Number(topScore.toFixed(4)),
    topPhrase: Number(topPhrase.toFixed(4)),
    effectivePhrase: Number(effPhrase.toFixed(4)),
    lexicalCoverage: Number(strictCoverage.toFixed(4)),
    orphanShare: Number(stats.orphanShare.toFixed(4))
  };

  // Two independent routes to a no-match verdict, because two different things
  // make a question unanswerable.
  //   VOCABULARY — the words that make the question specific exist nowhere in
  //     the corpus, and nothing in it holds the remaining words together. This
  //     is the strong signal, and it does not need a score threshold: an
  //     orphan share this high means the corpus has never discussed the thing.
  //   EVIDENCE — every word is familiar, but nothing scored, nothing is
  //     phrased that way, and most of the question went unanswered. Needs all
  //     three because each one alone fires on real questions.
  const byVocabulary = stats.orphanShare >= orphanFloor && effPhrase < phraseFloor;
  const byEvidence = topScore < scoreFloor && effPhrase < phraseFloor && strictCoverage < coverageFloor;
  if (!byVocabulary && !byEvidence) {
    return { confidence: topScore >= scoreFloor ? 'high' : 'medium', signals, results };
  }

  // Is this the "your words, not the corpus's words" refusal? See absenceNote below for the
  // measurement. Derived from scoreFloor rather than a new constant, because the two routes
  // already partition on it: byEvidence cannot fire at or above scoreFloor.
  const readThisFirst = topScore >= scoreFloor;
  const why = byVocabulary
    ? `the term(s) that make this question specific appear NOWHERE in the corpus (${stats.orphans.join(', ')} — ` +
      `${(stats.orphanShare * 100).toFixed(0)}% of the query's discriminative weight, floor ${orphanFloor * 100}%)`
    : `best score ${topScore.toFixed(3)} < ${scoreFloor}, no passage holds these words together ` +
      `(effective phrase ${effPhrase.toFixed(3)} < ${phraseFloor}), and only ${(strictCoverage * 100).toFixed(0)}% of the question ` +
      `is answered lexically (floor ${(coverageFloor * 100).toFixed(0)}%)`;

  return {
    noStrongMatch: true,
    confidence: 'low',
    signals,
    // VERIFY-THEN-QUOTE, not never-quote. The old wording said a bestWeak row
    // is never an answer, full stop — and the library casualty proved that
    // over-refuses: the answer was sitting verbatim in the returned snippet
    // while the server said it had nothing. A caller who can OPEN the section
    // and see the sentence is not guessing. What stays forbidden is the thing
    // that actually goes wrong: reporting a near neighbour as a memory of the
    // thing asked because it came back and looked plausible.
    absenceNote: readThisFirst
      // SEMANTICALLY CLOSE, LEXICALLY FAR — lead with the instruction, not the prohibition.
      // The evidence route REQUIRES topScore < scoreFloor, so a refusal that scored ABOVE it
      // can only have come from the vocabulary route: everything about this result is strong
      // except that the caller's words are not the corpus's words. That is the case where the
      // answer is most often sitting in bestWeak[0] — measured 21/21 on a corpus whose own
      // vocabulary was too narrow to recognise ordinary questions, against 0/40 and 0/40 for
      // questions with nothing close on either corpus (test/fixtures/ordinary-word-absences.json
      // and the pre-registration). The old wording opened with "do not report one as a memory
      // of this", which is the right rule and the wrong first sentence: the reader who most
      // needs to OPEN the document is the one being told first what not to do with it.
      //
      // This changes NO verdict and no score. noStrongMatch, bestWeak and every signal are
      // exactly as before; only the order and emphasis of the sentence differ.
      // TWO CORRECTIONS, both from a first-use report by a reader who had never seen this tool.
      //
      // 1. It reused the ABSENCE branch's wording — "the term(s) that make this question specific
      //    appear NOWHERE in the corpus (often, feed)" — which is literally true and pragmatically
      //    false here. Measured case: the corpus says "the starter is fed twice a day", so the FORM
      //    "feed" appears nowhere, and the note announced the topic was missing while the answer sat
      //    at 0.966. The reader's words for it: "the tool talks itself out of matches it actually
      //    made." This branch now says the true thing — your exact forms are not in it — and stops
      //    implying an absence that is precisely what this branch exists to leave UNDECIDED.
      // 2. It ran to 125 words of near-identical hedging on every refusal, dwarfing the data it was
      //    attached to. A warning nobody finishes reading is not a warning.
      ? `READ BEFORE JUDGING: a document here scored ${topScore.toFixed(3)}, but your distinctive ` +
        `words are not in it (stems: ${(stats.orphans || []).join(', ')} — ` +
        `${(stats.orphanShare * 100).toFixed(0)}% of the query; the corpus may use other forms of the ` +
        'same idea). That looks identical whether it is your answer in different language or a ' +
        'different topic nearby, so only the text decides. OPEN bestWeak[0] and read it: cite it if ' +
        'it answers, say the memory is absent if it does not.'
      : `No strong match: ${why}. The documents under bestWeak are the nearest neighbours, NOT ranked ` +
        'answers — do not report one as a memory of this on the strength of its rank. But they are real ' +
        'passages: if a snippet appears to contain the answer, OPEN its section and read it, and you may ' +
        'rely on what you can see there. Quote what you verified, not what was returned.',
    results: [],
    bestWeak: results.slice(0, weakResults)
  };
}

/** Top-N semantically nearest docs to `doc` — the free expansion signal. */
export async function nearest(doc, docs, n = 3) {
  const vecs = (doc.chunks || []).map((c) => c.vec).filter(isVec);
  if (!vecs.length) return [];
  const out = [];
  for (const other of docs) {
    if (other.name === doc.name) continue;
    let best = -1;
    for (const c of other.chunks || []) {
      if (!isVec(c.vec)) continue;
      for (const v of vecs) {
        const s = cosine(v, c.vec);
        if (s > best) best = s;
      }
    }
    if (best > 0) out.push({ name: other.name, similarity: Number(best.toFixed(4)), tier: other.tier });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out.slice(0, n);
}


// ---------------------------------------------------------------------------
// latest() — "what is the CURRENT STATE of X", as opposed to "what best matches X".
//
// WHY THIS EXISTS, and it is a usage failure made concrete. Asked whether a
// re-parse had finished, I ran a similarity search, got the exchange where the
// work STARTED at 0.88, saw no completion above it, and reported the answer was
// unknowable. It was not. The corpus held the conclusion — in the very same
// exchange — and an exhaustive scan ordered by time found it immediately.
//
// Similarity cannot separate "we are starting X" from "X is finished": both look
// equally like a question about X. Ranking by relevance and reading the top hit
// is the WRONG METHOD for a state question, however good the ranker is.
//
// So: match on terms (exhaustively, no ranking), then order by TIME, newest
// first. The last thing said about a topic is the last word on it — and if the
// thread simply stops, "last word: still in progress" is at least honest.
// A corpus's CLOCK, derived from its data rather than assumed. Exchanges ingested
// from transcripts carry `ts` — when the words were actually said. Curated memory
// files do not, so their only ordering is file mtime, and mtime is BOOKKEEPING,
// not chronology: the 2026-08-19 account-labelling backfill rewrote all 118
// curated files in a single pass, so by mtime every one of them outranks a
// genuine 08-22 conversation. That is why `scope:'all'` segments instead of
// merging — see latestAll().
// How many times the query's terms occur in a document. A term mentioned once in
// 17k characters and a term the document is ABOUT are both "a match" to an AND
// filter; this is what lets a caller tell them apart without reading the body.
// The snippet, taken AROUND THE MATCH and anchored on the RAREST term -- the most
// distinctive one, and so the one whose neighbourhood explains why this document
// came back. Falls back to the document tail only if nothing is locatable.
function matchSnippet(body, terms, df) {
  const hay = String(body || '').toLowerCase();
  const ranked = [...terms].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
  for (const t of ranked) {
    const i = hay.indexOf(t);
    if (i !== -1) return snippetAround(body, i, i + t.length);
  }
  return body.slice(-RETRIEVAL.snippetChars * 2);
}

// CONTEXT-COMPACTION SUMMARIES ARE DERIVATIVE DOCUMENTS, and for a time-ordered
// question they are actively harmful.
//
// When a session runs out of context the harness re-opens it with a summary of
// everything so far, and ingest stores that as an exchange like any other. The
// result is a very long document that restates an entire conversation -- so it
// contains almost every term, matches almost every AND filter, and carries a
// RECENT timestamp. Measured: 34 of 2,318 documents, and one of them took first
// place on 5 of 6 real test questions, including one where its only relevance was
// that it restated the QUESTION.
//
// This is the corpus-clock mismatch in miniature: the `ts` says now, the content
// is about before. A summary of the past cannot be the last word by construction,
// so it must never take first place from a real exchange.
//
// EXCLUDING them outright was tried first and measured WORSE: on the six-question
// test it fixed one question (the real answer had been buried under a summary that
// merely restated the QUESTION) and broke another (whose answer existed ONLY in a
// summary -- a distilled index of a conversation is sometimes the best source
// there is). So they are DEMOTED and LABELLED, never dropped: a summary can still
// answer, it just cannot outrank a first-hand exchange. `includeSummaries:false`
// removes them entirely for a caller who wants only primary sources.
//
// The marker is an exact string the HARNESS emits, not a vocabulary anyone wrote
// -- the standing rule against hand-written regexes is about inferring meaning
// from language, which this is not.
const COMPACTION_MARKER = 'This session is being continued from a previous conversation';
function isCompactionSummary(doc) {
  const head = ((doc.description || '') + ' ' + String(bodyOf(doc) || '').slice(0, 400));
  return head.includes(COMPACTION_MARKER);
}

function countHits(body, terms) {
  const hay = String(body || '').toLowerCase();
  let n = 0;
  for (const t of terms) {
    let i = hay.indexOf(t);
    while (i !== -1) { n++; i = hay.indexOf(t, i + t.length); }
  }
  return n;
}


// Attach VERIFIED commits to result rows, in ONE batch for the whole response.
//
// Per-row verification would spawn git once per result per repo; collecting every
// candidate first means a query costs one process, and the module's cache makes
// repeat queries free. Rows gain `verifiedCommits` only when something actually
// verified -- an empty array on every row would be noise, and would also imply
// "nothing was committed" when the truth is "no SHA was cited here".
async function attachCommits(rows, bodies) {
  if (!configuredRepos().length || !rows.length) return rows;
  // BOUNDED. A compaction summary can cite 27 commits, and a response is several
  // rows: uncapped, one cold query spent 2.6 s verifying tokens nobody asked about.
  // The cap is per row, because the first SHAs a document cites are the ones it is
  // about and the tail is usually incidental.
  const PER_ROW = 12;
  const per = rows.map((_, i) => extractShas(bodies[i]).slice(0, PER_ROW));
  const all = [...new Set(per.flat())].slice(0, 60);
  if (!all.length) return rows;
  let found;
  try {
    found = await verifyShas(all);
  } catch {
    return rows;   // verification is an ENRICHMENT: never fail a query over it
  }
  if (!found.size) return rows;
  rows.forEach((r, i) => {
    const hits = per[i].filter((sh) => all.includes(sh)).map((sh) => found.get(sh)).filter(Boolean)
      .map((c) => ({ sha: c.sha, repo: c.repo, date: c.date, onMainline: c.onMainline, subject: c.subject }));
    if (hits.length) r.verifiedCommits = hits;
  });
  return rows;
}

// ── "That term is not missing — your index predates it" ────────────────────
//
// On 2026-08-25 a search for `v111 zip shipped gates` returned v108/v107/v105.
// `release-v111-shipped.md` had been added AFTER the index was built, so `v111` came
// back in `unmatchableTerms` and the answer was two releases stale. The response
// already carried BOTH halves — `unmatchableTerms: ["v111"]` and a
// `staleFilesAdded` list naming `release-v111-shipped.md` — and nothing connected
// them. The caller saw a plausible answer from the wrong era.
//
// So: when an unmatchable term appears in the FILENAME of a file the staleness
// check just reported as added or changed, say that outright. It converts a
// generic "index is stale" warning into a diagnosis of the specific query.
function staleTermCollision(unmatchable, stamp) {
  const files = [...(stamp.staleFilesAdded || []), ...(stamp.staleFilesChanged || [])];
  if (!files.length || !unmatchable || !unmatchable.length) return null;
  const hits = [];
  for (const term of unmatchable) {
    const t = String(term).toLowerCase();
    if (t.length < 3) continue;
    const named = files.filter((f) => String(f).toLowerCase().includes(t));
    if (named.length) hits.push({ term, files: named.slice(0, 4) });
  }
  if (!hits.length) return null;
  return 'YOUR INDEX PREDATES THE ANSWER — ' + hits.map((h) =>
    `${JSON.stringify(h.term)} matches no INDEXED document, but it appears in the name of ` +
    `${h.files.map((f) => JSON.stringify(f)).join(', ')}, which the staleness check just reported as ` +
    'added/changed since this index was built').join('; ') +
    '. This is not an absence, it is a stale index. Rebuild before trusting the ordering: ' +
    'memory({action:"index"}) (async) or `npm run index`.';
}

// ── The same principle, one scope wider: scan the CONTENT ──────────────────
//
// staleTermCollision above matches an unmatchable term against stale FILENAMES.
// On 2026-08-29 that was not enough. A query for the ship SHA `31cab63` returned
// totalMentions 0 / unmatchableTerms ["31cab63"], and I reported that a session had
// never been captured. It had — 149 exchanges — and the SHA sat in the CONTENT of
// three unindexed store files whose names contain no SHA at all. The response
// carried `indexStale: true` and a 163-file warning in the same breath as the zero.
//
// So when a term matches nothing INDEXED and the index is known stale, read the
// stale files before saying the word "absent". Bounded by construction: it runs
// only when an absence would otherwise be reported, and only over files already
// known to be stale.
const STALE_SCAN_MAX_FILES = 500;
const STALE_SCAN_MAX_BYTES = 32 * 1024 * 1024;

function staleContentScan(unmatchable, stamp) {
  // 🟥 MEM-41. THE GATE COMES FIRST, BEFORE THE READ AND BEFORE THE NAME. This scan's entire
  // output is "<term> appears in <filename>", and on 2026-09-05 the big test asked for a
  // password-shaped token and got back the confirmation that it lives in
  // `store/booth-nas-ssh-credentials.md` — the disclosure the denylist exists to prevent, made by
  // the honesty layer. A file the indexer refuses is not read here and cannot be named here; the
  // count of what was withheld rides on the stamp as `gatedFiles`.
  const gated = (stamp && stamp._gatedFileIds) || null;
  const all = stamp && stamp._staleScan;
  const files = gated && gated.size ? (all || []).filter((f) => !gated.has(f.fileId)) : all;
  if (!files || !files.length || !unmatchable || !unmatchable.length) return null;
  const terms = unmatchable.map((t) => String(t).toLowerCase()).filter((t) => t.length >= 3);
  if (!terms.length) return null;

  const hits = new Map();
  let bytes = 0;
  // 🟥 F2 (2026-08-30). Both caps below TRUNCATE, and until now they did so silently:
  // when the scan found nothing it returned null and the caller reported a clean absence,
  // with no hint that most of the stale files were never opened. Measured: the same file
  // and token found at 1 stale file, missed at 601. A bounded scan is correct; a bounded
  // scan that presents itself as exhaustive is the thing this whole guard exists against.
  let scanned = 0;
  const total = files.length;
  for (const f of files.slice(0, STALE_SCAN_MAX_FILES)) {
    if (bytes > STALE_SCAN_MAX_BYTES) break;
    scanned++;
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    bytes += text.length;
    const hay = text.toLowerCase();
    for (let i = 0; i < terms.length; i++) {
      if (!hay.includes(terms[i])) continue;
      const key = unmatchable[i];
      if (!hits.has(key)) hits.set(key, []);
      const list = hits.get(key);
      if (list.length < 6) list.push(f.fileId);
    }
  }
  const truncated = scanned < total;
  const truncNote = truncated
    ? ` ⚠️ ONLY ${scanned} OF ${total} STALE FILES WERE READ (cap: ${STALE_SCAN_MAX_FILES} files / ` +
      `${Math.round(STALE_SCAN_MAX_BYTES / 1048576)} MB), so this scan is NOT exhaustive — ` +
      'a term absent from BOTH the index and this partial scan may still exist in a file ' +
      'nobody opened. Rebuild before treating it as missing.'
    : '';

  // Nothing found, but the scan was cut short: that is NOT the same as "nothing there",
  // and it is the caller who has to be told, because the absence verdict is theirs to make.
  if (!hits.size) {
    return truncated
      ? { foundInUnindexed: {}, scanTruncated: { filesScanned: scanned, filesTotal: total },
          note: 'INCONCLUSIVE, NOT ABSENT.' + truncNote }
      : null;
  }

  const parts = [...hits.entries()].map(([term, fs]) =>
    `${JSON.stringify(term)} appears in ${fs.map((f) => JSON.stringify(f)).join(', ')}`);
  return {
    foundInUnindexed: Object.fromEntries(hits),
    ...(truncated ? { scanTruncated: { filesScanned: scanned, filesTotal: total } } : {}),
    note: 'NOT ABSENT — UNINDEXED. ' + parts.join('; ') + truncNote +
      ', which the staleness check reports as added/changed since this index was built. ' +
      'The zero above counts INDEXED documents only. Do not report this as missing: ' +
      'rebuild first with memory({action:"index"}) (async) or `npm run index`.'
  };
}

// ---- WHAT CLOCK IS THIS CORPUS ORDERED BY? -------------------------------
//
// Three answers, not two. `ts` is a CAPTURED timestamp — the extractor recorded when the words were
// actually said, and nothing about the file can change it. `mtime` is a filesystem fact about bytes,
// which the 2026-08-19 account backfill destroyed as chronology by rewriting 118 curated files in
// one pass. Between them sits the case this function used to collapse into `mtime` and mislabel:
// a RECORDED `metadata.modified` carrying a declared `modifiedSource` (`git-floor` = the earliest
// commit that touched the file, `stop-hook` = the session that wrote it). That is a CLAIM ABOUT THE
// WORLD, made deliberately by a writer that knew the answer — weaker than a captured `ts`, and far
// stronger than "whenever these bytes were last touched".
//
// Calling it 'mtime' told the caller to distrust an ordering that is in fact roughly right, on the
// one corpus (curated) where nothing better exists. Calling it 'ts' would be a lie of the opposite
// kind. So it gets its own name and its own sentence.
export function corpusClock(idx) {
  const docs = idx.docs || [];
  if (!docs.length) return 'mtime';
  const withTs = docs.reduce((n, d) => n + (d.ts ? 1 : 0), 0);
  if (withTs > docs.length / 2) return 'ts';
  const withSource = docs.reduce((n, d) => n + (d.modifiedSource ? 1 : 0), 0);
  if (withSource > docs.length / 2) return 'factTime';
  return 'mtime';
}

// ONE PLACE for what each clock MEANS, because the claim was previously built inline in three
// places (latest's guidance, latestAll's section note, latestAll's top-level note) as a two-way
// ternary — and a third value would have silently taken the 'mtime' branch in all three.
//
// `note` is the full sentence a section carries; `phrase` is the fragment the inline
// "Ordered NEWEST FIRST by ___" guidance line needs. `voidNote` is the same claim when unread
// files are NEWER than results[0]: it must NOT say "results[0] is the last word", which is the
// self-contradiction the recency guard was written to end.
const CLOCK_NOTES = Object.freeze({
  ts: Object.freeze({
    phrase: 'when it was said',
    note: 'Ordered NEWEST FIRST by when it was said.',
    voidNote: 'Ordered newest-first by when it was said — but ONLY over what is indexed, and unread ' +
      'files are newer. results[0] is NOT the last word here.'
  }),
  factTime: Object.freeze({
    phrase: 'a RECORDED metadata.modified date (declared source, not a captured timestamp)',
    note: 'Ordered by a RECORDED `metadata.modified` date, each carrying a declared `modifiedSource` ' +
      '(`git-floor` = the NEWEST commit that touched the file before stamping began — a floor under the ' +
      'real date, not the date itself; `stop-hook` = the commit that carried the change, real fact-time). ' +
      'That is a CLAIM ABOUT THE WORLD made by the writer, not a captured timestamp: weaker than ' +
      'a `ts` (which records when the words were actually said) and much stronger than a file mtime ' +
      '(which records only when bytes were last rewritten). Read the order as approximately right, ' +
      'never as proof of sequence.',
    voidNote: 'Ordered by a RECORDED `metadata.modified` date (a declared claim, not a captured ' +
      'timestamp) — and ONLY over what is indexed, while unread files are newer. results[0] is NOT ' +
      'the last word here.'
  }),
  mtime: Object.freeze({
    phrase: 'FILE MTIME (not chronology)',
    note: 'NOT TIME-ORDERED. This corpus carries no timestamps, so this is FILE MTIME only — ' +
      'the 2026-08-19 account backfill rewrote every curated file at once, so mtime order ' +
      'here is bookkeeping, not chronology. Do not read section order as "what happened last".',
    voidNote: 'NOT TIME-ORDERED. This corpus carries no timestamps, so this is FILE MTIME only — ' +
      'the 2026-08-19 account backfill rewrote every curated file at once, so mtime order ' +
      'here is bookkeeping, not chronology. Do not read section order as "what happened last". ' +
      'Unread files are also newer than anything ranked here.'
  })
});

export function corpusClockNote(clock, { recencyVoid = false } = {}) {
  const e = CLOCK_NOTES[clock] || CLOCK_NOTES.mtime;
  return recencyVoid ? e.voidNote : e.note;
}
export function corpusClockPhrase(clock) {
  return (CLOCK_NOTES[clock] || CLOCK_NOTES.mtime).phrase;
}

// ---- SCOPE GRAMMAR ---------------------------------------------------------
// A scope is a string or an array, freely mixing corpus names, category names,
// 'all' and 'everything'. Expansion is a union, deduped; the RESULT ORDER puts
// the work corpora first (in CORPORA order) because scope:'everything' exists
// for someone who does not know where a thing lives, and the work corpora are
// where it usually does.
//
// 'all' expands to CORPORA and NOTHING ELSE — that is Daniel's rule, and it is
// what makes the library's reach isolation real: a category is searched only
// when a caller names it, or names 'everything'.
export function expandScope(scope) {
  const parts = Array.isArray(scope) ? scope : [scope];
  const names = [];
  for (const s of parts) {
    if (s === 'all') names.push(...CORPORA);
    else if (s === 'everything') names.push(...CORPORA, ...libraryCorpora());
    else names.push(s);
  }
  const dedup = [...new Set(names)];
  return [...CORPORA.filter((c) => dedup.includes(c)), ...dedup.filter((c) => !CORPORA.includes(c))];
}

function isMultiScope(scope) {
  return Array.isArray(scope) || scope === 'all' || scope === 'everything';
}

// ---- ONE EMPTY CORPUS MAY NOT SPEAK FOR THE OTHERS (MEM-85) -----------------------------------
//
// Measured 2026-09-07 on a live 1.7.2 Mac, one scope:'all' response — the verbatim payload is
// MEMORY-MCP-AGENT-REPORTS-2026-09-05/mac-chat-search-all-evidence-2026-09-07.json. Four sections:
// curated fresh, staging FRESH with 10 ranked hits from a 2,983-file index built 7 minutes earlier,
// handoff fresh, and `projects` — a corpus that machine has no other project's memory folder for:
// 0 corpus files, no index. The TOP LEVEL read `indexStale: true`, `staleFiles: 0`, and "There is
// no index on disk, so nothing here was RANKED from the corpus", because both aggregate builders
// ORed `indexStale` across every scope and lifted the warning TEXT out of whichever one set it.
//
// The response contradicted itself twice in the same object — `staleFiles: 0` beside
// `indexStale: true`, and "no index on disk" beside three real `indexBuiltAtByScope` timestamps —
// and a caller who believes the envelope abandons a search that succeeded.
//
// ensureFresh already tells EMPTY from STALE (`stamp.empty`, see its no-index branch). This is the
// aggregate half, and it does two things the old two-liner could not:
//   * an EMPTY scope contributes NOTHING to the top-level verdict. Nothing can be behind nothing.
//   * the top-level warning is WRITTEN here rather than hoisted out of a group, so it can NAME the
//     stale corpus without negating the ones that answered. A single scope's sentence, promoted
//     unchanged to the top of a four-section response, can only be read as a global verdict.
//
// Shared by all three grouped builders (searchAll's two returns and latestAll) so they cannot
// disagree about freshness — which is how MEM-81 happened to `configWarning`.
export function aggregateFreshness(names, get, { where = (s) => `groups.${s}` } = {}) {
  const isEmpty = (s) => get(s)?.empty === true;
  const emptyScopes = names.filter(isEmpty);
  const staleScopes = names.filter((s) => !isEmpty(s) && get(s)?.indexStale === true);
  const okScopes = names.filter((s) => !isEmpty(s) && !staleScopes.includes(s));
  const staleAny = staleScopes.length > 0;
  const staleFiles = staleScopes.reduce((a, s) => a + (Number(get(s)?.staleFiles) || 0), 0);

  let staleWarning;
  if (staleAny) {
    const named = staleScopes.map((s) => {
      const r = get(s) || {};
      const n = Number(r.staleFiles);
      // WHICH stale, said in three words, because the three states need different action:
      // corrupt (a file to replace), behind (a rebuild), never built (a first build).
      const what = r.indexCorrupt ? 'its index file is UNREADABLE (truncated or corrupt)'
        : r.indexBuiltAt ? 'its index is BEHIND the corpus'
          : 'it has corpus files and NO index';
      return `[${s}] ${what}` +
        (Number.isFinite(n) && n > 0 ? ` — ${n} file(s) added or changed since the build` : '') +
        `; detail in ${where(s)}.staleWarning.`;
    }).join(' ');
    // THE HALF MEM-85 WAS MISSING. Naming the corpora that answered normally is what stops a
    // per-scope fact reading as a claim about the whole response.
    const rest = [
      okScopes.length ? `${okScopes.join('/')} ranked normally` : null,
      emptyScopes.length
        ? `${emptyScopes.join('/')} ${emptyScopes.length === 1 ? 'is' : 'are'} EMPTY ` +
          `(0 corpus files) — see ${emptyScopes.length === 1 ? 'its own section' : 'their own sections'}`
        : null
    ].filter(Boolean).join('; ');
    staleWarning = named + (rest ? ` The rest of this response stands: ${rest}.` : '');
  }
  return { emptyScopes, staleScopes, okScopes, staleAny, staleFiles, staleWarning };
}

// The tripwire for the sentence that started MEM-85, asserted on the FINISHED envelope rather than
// trusted to the writer above. The property is about the response, not about one function: a
// populated `indexBuiltAtByScope` proves at least one index exists, and `staleFiles: 0` proves
// nothing was measured behind it — so "there is no index on disk" is FALSE at this level whatever
// produced it. Withheld and logged, never shipped: the whole defect was a false sentence a caller
// believed over the ten results sitting beside it.
const NO_INDEX_SENTENCE = /no index on disk/i;
export function refuseGlobalNoIndexClaim(env, where = 'grouped response') {
  const built = env?.indexBuiltAtByScope || {};
  const have = Object.entries(built).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k);
  if (!have.length || Number(env.staleFiles) !== 0) return env;
  if (typeof env.staleWarning === 'string' && NO_INDEX_SENTENCE.test(env.staleWarning)) {
    log(`[MEM-85] ${where}: WITHHELD a top-level "no index on disk" claim over indexes that exist ` +
        `(${have.join('/')}) with staleFiles 0 — ${env.staleWarning.slice(0, 140)}`);
    delete env.staleWarning;
    env.staleWarningWithheld =
      'A top-level "no index on disk" warning was WITHHELD (MEM-85): this response carries index ' +
      `timestamps for ${have.join('/')} and measured 0 stale files, so the sentence was false at ` +
      'this level. Each section still reports its own freshness — read those.';
  }
  return env;
}

// ---- THE EVERYTHING VIEW IS COMPACT, AND SAYS SO ---------------------------
// scope:'everything' is the read-across-eight-corpora scope, and at named-scope
// defaults it answered a broad query with ~54 KB of response — the blind reader
// drowned. PRESENTATION ONLY: every group is ranked exactly as its named scope
// would rank it, then the VIEW trims — fewer rows per section, shorter
// snippets, null fields dropped, per-group boilerplate said once at the top.
//
// DEFAULTS, NOT CEILINGS (Daniel's ruling): an explicit `limit` or `maxChars`
// on the call overrides them fully. And nothing trims silently — every trimmed
// section carries a line saying how many rows exist and what gets the rest,
// because a slice that looks like a whole document is how a caller concludes
// something is absent (the documented get() trap, same failure shape).
const EVERYTHING_VIEW = { rowsPerSection: 2, snippetChars: 160, descriptionChars: 140 };

// How many nearest-neighbour rows a section that ranked NOTHING keeps when ANOTHER section
// answered — names and scores only, enough to decide whether to open one. See MEM-86(b) below.
const WEAK_CAP_WHEN_ANOTHER_HIT = 3;

// ---- SAID ONCE, NOT ONCE PER SECTION (MEM-86, the same principle as resultsRef) ---------------
//
// A grouped response is four (or eight) whole single-scope envelopes side by side, and some of
// what a single-scope envelope carries is IDENTICAL in every one of them or is a per-corpus
// DIAGNOSTIC that makes no claim about the answer. Measured on the 2026-09-07 query after the
// dedupe and the bestWeak cap: 1,037 bytes of byte-identical repetition (`query` ×4,
// `modifiedFieldNote` ×4, `serverVersion`/`serverStartedAt` ×4) and 1,093 more of per-corpus
// diagnostics — every one of which test/run-tests.js's (a75) AGGREGATED_AS map has ALREADY
// adjudicated as "not reproduced per section", with the reason, for the array-scope copy. This
// makes the code agree with that decision for scope:'all' too; `modifiedFieldNote`'s entry there
// literally reads "said ONCE (search puts it at the wrapper top level)", and for scope:'all' it
// was said four times and nowhere at the top.
//
// 🟥 WHAT MAY NOT GO IN THIS LIST. Anything that states what was or was not READ: indexStale,
// staleFiles, staleWarning, staleFilesAdded/Changed, empty, emptyNote, recencyVoid,
// recentUnindexed, unindexedChecked, foundInUnindexed, premiseSupported, captureHealth,
// uncapturedSessions, configWarning, guidance, unmatchableTerms, noStrongMatch, confidence,
// bestWeak. Those are the MEM-27 fields, they are why a caller does not conclude the wrong thing,
// and a byte budget is not a reason to withhold one. This list is duplication and diagnostics.
const GROUP_SAID_ONCE = [
  // byte-identical in every group, and already at the wrapper top level
  'query', 'serverVersion', 'serverStartedAt',
  // identical in every group; hoisted to the top level below, so it is still SAID
  'modifiedFieldNote',
  // per-corpus diagnostics, each carrying no claim about the answer (AGGREGATED_AS, with reasons)
  'indexPath', 'indexCheckMs', 'indexCheckedFiles', 'newestSourceModified', 'staleNewestModified',
  'staleFilesRemoved'
];

// ---- brief:true — THE ROWS SHRINK, THE CAVEATS DO NOT (MEM-86c) -------------------------------
//
// `get` has had `brief` since its own absence note started telling callers to open bestWeak[0].
// `search` and `latest` never did, and they are the two actions that return TEN rows of ~25 fields
// each. Measured on the 2026-09-07 payload: the ten staging rows cost 13,558 bytes, twice over,
// while name + score + snippet for all ten would have been 4,054 characters.
//
// WHAT MAY NEVER BE TRIMMED IS THE ENVELOPE. indexStale, staleWarning, recencyVoid,
// recentUnindexed, uncapturedSessions, captureHealth, configWarning, guidance — every one of them
// exists because a caller who does not see it reaches a confident wrong answer, and a caller
// asking for fewer BYTES has not asked to be told less about what was not read. brief trims ROWS.
// (a98) asserts exactly that, field by field, against a response with every stamp lit.
const BRIEF_ROW_KEEP = ['name', 'corpus', 'score', 'snippet', 'provenance', 'ts', 'modified'];
const BRIEF_NOTE = 'brief:true — each row carries name/corpus/score/snippet/provenance and its ' +
  'timestamp and NOTHING else: no path, no type, no description, no per-leg scores, no thread ' +
  'position, no verified commits. The ENVELOPE is untouched: every freshness and honesty field is ' +
  'still here, because brief trims rows, never caveats. memory({action:"get", name}) reads one in full.';

function briefRow(r) {
  const o = {};
  for (const k of BRIEF_ROW_KEEP) if (r?.[k] !== null && r?.[k] !== undefined) o[k] = r[k];
  return o;
}
/**
 * Trim the ROWS of a finished response, in place. Called AFTER logQuery on purpose: the telemetry
 * row records what was ranked, and a presentation flag must not change what the log says happened.
 * `top:false` for a group inside a grouped response — the note is worth its bytes once, not four times.
 */
function briefRows(res, { top = true } = {}) {
  for (const f of ['results', 'bestWeak']) if (Array.isArray(res[f])) res[f] = res[f].map(briefRow);
  for (const sec of (Array.isArray(res.sections) ? res.sections : [])) {
    for (const f of ['results', 'bestWeak']) if (Array.isArray(sec[f])) sec[f] = sec[f].map(briefRow);
  }
  if (top) res.briefNote = BRIEF_NOTE;
  return res;
}

// What a compact ROW keeps: identity, the fused score, provenance, the snippet,
// and the fields that prevent known misreadings (thread position, verified
// commits, modified). Diagnostics (per-leg scores, file ids, paths, tiers,
// links) live one named-scope call away, and the compactNote says so.
const EV_ROW_KEEP = ['name', 'corpus', 'type', 'description', 'score', 'provenance', 'snippet', 'modified',
  'threadPosition', 'laterInThread', 'threadLast', 'sessionTitle', 'verifiedCommits'];
// What a compact GROUP keeps: the verdict, the honesty fields, and the rows.
// absenceNote is deliberately NOT here — it is the same sentence in every
// noStrongMatch group, so the compact view says it ONCE at the top level;
// the per-group noStrongMatch/confidence flags stay.
const EV_GROUP_KEEP = ['results', 'bestWeak', 'noStrongMatch', 'confidence', 'totalCandidates',
  'indexStale', 'indexCorrupt', 'staleFiles', 'staleWarning', 'mode', 'premiseSupported',
  // MEM-85: the two fields that separate an EMPTY corpus from a stale one. Cheap (a boolean and
  // one sentence, present only when true) and the compact view is where a reader is most likely to
  // mistake a silent section for a failed one.
  'empty', 'emptyNote',
  // Freshness CLAIMS survive the compact view (2026-09-05): when capture itself broke, or a transcript
  // has grown past its last capture, a reader of the everything view must be told as much as a
  // reader of the named scope. Small, staging-only, and absent when all is well.
  'lastIngestAt', 'captureHealth', 'uncapturedSessions', 'recentUnindexed', 'unindexedChecked',
  // MEM-68/U-4: scope:'everything' is exactly the view that silently omits the library categories
  // this warning is about, so the compact view is the LAST place it may be dropped.
  'configWarning'];
// Group-guidance lines that are generic advice restated identically on every
// response of that scope — pure repetition in the everything view. Anything
// carrying SPECIFIC names (orphan alarms, mid-thread pointers, collisions)
// survives.
const EV_GROUP_GUIDANCE_DROP = [
  /^scope defaulted to CURATED/, /library categor/,
  /conversation EXCHANGES — a moment in a chat/,
  /^Some of these ARE the last exchange of their thread/
];

function compactRow(r, snipCap, descCap) {
  const out = {};
  for (const k of EV_ROW_KEEP) {
    if (r[k] === null || r[k] === undefined) continue;
    out[k] = r[k];
  }
  // A read-only row must SAY so in every view — the caller who tries to demote
  // it deserves the warning before the refusal. Absence of the field means
  // writable, so only `true` is worth the bytes.
  if (r.readOnly === true) out.readOnly = true;
  if (typeof out.snippet === 'string' && out.snippet.length > snipCap) out.snippet = out.snippet.slice(0, snipCap) + '…';
  if (typeof out.description === 'string' && out.description.length > descCap) out.description = out.description.slice(0, descCap) + '…';
  return out;
}

function compactEverythingGroups(groups, names, { rowCap, snipCap }) {
  const descCap = EVERYTHING_VIEW.descriptionChars;
  const out = {};
  for (const s of names) {
    const g = groups[s];
    const ranked = (g.results?.length || 0) + (g.bestWeak?.length || 0);
    // An empty corpus is one honest line, not nineteen stamped fields.
    // 🟥 MEM-85 — and "empty" and "stale" are DIFFERENT one-liners. A corpus with 0 files has
    // nothing to be behind, and calling its index stale here is the same false claim the top level
    // used to make; `empty` rides through from ensureFresh so this view inherits the distinction
    // rather than re-deriving it.
    if (!ranked) {
      out[s] = { noStrongMatch: true,
        ...(g.empty === true ? { empty: true } : {}),
        compactNote: `nothing ranked in '${s}'` +
          (g.empty === true
            ? ' — this corpus is EMPTY (0 corpus files, no index), so there was nothing to rank and nothing to build'
            : g.indexStale ? ' (its index is STALE — see staleWarning at the top level)' : '') +
          `; scope:'${s}' gives the full empty-section detail.` };
      continue;
    }
    const g2 = {};
    for (const k of EV_GROUP_KEEP) if (g[k] !== undefined) g2[k] = g[k];
    const gGuide = (g.guidance || []).filter((l) => !EV_GROUP_GUIDANCE_DROP.some((re) => re.test(l)));
    if (gGuide.length) g2.guidance = gGuide;
    for (const field of ['results', 'bestWeak']) {
      if (!Array.isArray(g[field])) continue;
      g2[field] = g[field].slice(0, rowCap).map((r) => compactRow({ ...r, corpus: s }, snipCap, descCap));
    }
    const shown = (g2.results?.length || 0) + (g2.bestWeak?.length || 0);
    g2.compactNote = `COMPACT everything view: ${shown} of ${ranked} ranked row(s)` +
      (typeof g.totalCandidates === 'number' ? ` (${g.totalCandidates} candidates in '${s}')` : '') +
      `, ${snipCap}-char snippets, diagnostic fields dropped. limit:/maxChars: raise this; ` +
      `scope:'${s}' returns the full section.`;
    out[s] = g2;
  }
  return out;
}

// ---- TASK-SHAPE ROUTING: A READ TASK IS NOT A SEARCH -----------------------
// The blind reader asked scope:'everything' to "summarize the <manual>" and got
// ranked fragments — correct retrieval, wrong tool. Two conservative triggers,
// per the query-log audit (689 distinct real queries):
//   * TITLE — the query, minus a leading summarize/overview verb and article,
//     slug-matches an indexed PARENT document name exactly. The strong signal.
//   * VERB — the query STARTS with a summarize/overview phrase. Start-anchored
//     because the audit found the one live 'summarize' besides the blind
//     reader's sat mid-way through a pasted mega-prompt (0/689 false fires
//     with the anchor). 'read the whole' was audited and DROPPED — it fired
//     mid-prose on an unrelated pasted analysis (1/689).
const READ_VERB_RE = /^\s*(?:summari[sz]e|(?:give\s+me\s+)?(?:an?\s+)?(?:summary|overview)\s+of)\b[:,]?\s*/i;
// D5 second half — ranking-adjacent, so it was flagged and barred before it
// was written. ON by default since 2026-08-28: the manuals read-task case
// stopped refusing (orphanShare 0.4908 -> 0, three page sections returned) and
// every protected number came back identical arm-to-arm — curated gold 10/10 /
// MRR 0.8833, absence 4/4, verbatim 6/6, library absence 10/10, library gold
// 12/12 · 11/12 · 8/12, currency r_cur / r_stale / FDR / abstention all equal.
// `0` disables. Numbers: test/read-verb-weight-preregistration.md.
const readVerbWeightEnabled = () =>
  !['0', 'false', 'off'].includes(String(process.env.MEMORY_READ_VERB_WEIGHT || '').toLowerCase());
const slugOfQuery = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function readTaskHint(query, names) {
  const verb = READ_VERB_RE.exec(String(query || ''));
  const remainder = verb ? String(query).slice(verb[0].length) : String(query);
  const slug = slugOfQuery(remainder.replace(/^\s*(the|a|an)\s+/i, ''));
  let titleDoc = null;
  if (slug.length >= 8) {                     // a shorter slug matches by accident
    for (const s of names) {
      let idx; try { idx = getIndex({ scope: s }); } catch { continue; }
      for (const d of idx.docs || []) {
        if (d.parentName) continue;           // parents only — a title names a document
        if (d.name === slug || slugOfQuery(d.name) === slug) { titleDoc = { name: d.name, scope: s }; break; }
      }
      if (titleDoc) break;
    }
  }
  if (!titleDoc && !verb) return null;
  const target = titleDoc
    ? `memory({action:"get", name:"${titleDoc.name}", outline:true})`
    : 'memory({action:"get", name:"<the document>", outline:true})';
  return 'READ TASK, NOT A SEARCH — ' +
    (titleDoc ? `this query is the title of the indexed document '${titleDoc.name}'` : 'this query asks for a summary/overview') +
    `. Search returns FRAGMENTS ranked by similarity, never the document. Read it instead: ${target}, ` +
    'then read sections with section:"<heading>". The fragments below are NOT the document.';
}

// `scope:'all'` used to fall through to loadScope's default and answer silently
// from CURATED ALONE while labelling itself 'all' — a confident answer that had
// never looked at 2,312 staged exchanges, including the conversation that settled
// the question. Merging the corpora is not the fix either (see corpusClock).
//
// So: one call, one section per corpus, each ordered by ITS OWN clock and saying
// so. Nothing is ranked against a clock it does not have, and the caller gets the
// comparison that is usually the real answer -- the standing rule says X, the last
// conversation says Y -- without having to know to ask twice.
// ---- WHAT A SECTION CARRIES ------------------------------------------------
//
// MEM-27, exactly: `latest` with scope ['staging','curated'] returned rows and NOTHING ELSE. The
// wrapper copied five keys out of each single-scope response — corpus, orderedBy, totalMentions,
// results, note — and dropped the other eighteen, every one of which exists to stop a confident
// wrong answer: indexStale, staleWarning, recencyVoid, foundInUnindexed, unindexedChecked,
// premiseSupported, relaxed/droppedTerms, filterWarning. A reader asking an array scope got the
// SAME rows as a named scope with none of the honesty. Worse, an empty section was `continue`d
// away, so a corpus that was stale AND matched nothing vanished entirely — the response could not
// even name the corpus whose freshness it had failed to check.
//
// So the copy is a LIST, not a literal, and the suite compares it against a real single-scope
// response (group (a75)). Adding a field to `latest` without adding it here is a test failure
// rather than a silently narrower array-scope answer.
export const SECTION_KEYS = Object.freeze([
  'corpus', 'orderedBy', 'empty', 'totalMentions', 'results', 'note',
  'indexBuiltAt', 'indexStale', 'indexCorrupt', 'staleFiles', 'staleWarning', 'staleFilesAdded', 'staleFilesChanged',
  'recencyVoid', 'guidance', 'foundInUnindexed', 'unmatchableTerms', 'unindexedChecked',
  // MEM-85: `empty` is wrapper-owned above (0 ROWS), which is a different fact from 0 corpus
  // FILES. `emptyNote` is the one that says which, so it must ride the array-scope copy.
  'emptyNote',
  'premiseSupported', 'relaxed', 'droppedTerms', 'termWarning', 'filterWarning', 'scopeFallback',
  // Coordinator review, 2026-09-05: the four the implementing agent flagged as "should be carried" —
  // each backs a claim that IS carried (relaxed → matchedTermsPerDoc; unmatchableTerms and the
  // substring-artefact line → the two termFrequencies maps; staging freshness → lastIngestAt) —
  // plus the two capture-side freshness fields the writers' work added to the staging stamp.
  'lastIngestAt', 'matchedTermsPerDoc', 'termFrequencies', 'termFrequenciesWholeWord',
  'captureHealth', 'uncapturedSessions',
  // MEM-68/U-4: a whole-install config fault. It is the same class as captureHealth — a claim
  // about what was NOT searched — so it rides the array-scope copy for the same reason.
  'configWarning'
]);

// Guidance lines that must not stay buried inside a section: each one says the answer above it
// cannot be trusted as given, and a caller reading the top of a multi-scope response would never
// see them. Hoisted verbatim, prefixed with the corpus they came from.
const HOIST_GUIDANCE = [
  /^NEWEST-FIRST CANNOT BE HONOURED/,
  /STILL BEING WRITTEN when captured/,
  /^NOT ABSENT — UNINDEXED/,
  /^PREMISE NOT SUPPORTED/,
  /read DIRECTLY from the store/
];

async function latestAll(query, opts) {
  // Generalised the same way search()'s grouped branch is: 'all' stays the work
  // set, 'everything' and arrays expand through the one scope grammar.
  const requested = opts.scope ?? 'all';
  const names = expandScope(requested);
  const sections = [];
  let total = 0;

  // The same aggregation search()'s multi-scope branch performs (see :902-922), so the two
  // wrappers report freshness identically instead of one of them reporting it at all.
  const builtByScope = {};
  // 🟥 MEM-85 — the per-scope responses are KEPT so aggregateFreshness can classify them (empty vs
  // stale) after the loop. The old code decided both inside the loop, by OR and by string-append,
  // which is exactly what let one empty corpus set the top-level verdict and supply its words.
  const byScope = {};
  const recencyVoidByScope = {};
  const unindexedByScope = {};
  const notFullyRead = [];
  const topG = [];

  for (const corpus of names) {
    const r = await latest(query, { ...opts, scope: corpus, _nested: true });
    let idxPresent = false;
    let clock = 'mtime';
    try {
      const i = getIndex({ scope: corpus });
      idxPresent = !!i.present;
      clock = corpusClock(i);
    } catch { /* an unreadable index is reported by the stamp below, not thrown */ }
    const rows = r.results || [];

    // THE WRAPPER OWNS SIX KEYS; EVERY OTHER SECTION KEY IS COPIED FROM THE NAMED-SCOPE RESPONSE.
    // A first version built `src` as a hand-written literal and THEN filtered it through
    // SECTION_KEYS — so adding a key to the list did nothing until someone also added it to the
    // literal, which is the drift the list exists to end (measured 2026-09-05: four keys added to
    // SECTION_KEYS were still dropped per section). SECTION_KEYS is now the only place a key is named.
    const WRAPPER_OWNED = new Set(['corpus', 'orderedBy', 'empty', 'totalMentions', 'results', 'note']);
    const section = {
      corpus,
      orderedBy: clock,
      // KEPT, NOT SKIPPED. An empty section still carries this corpus's freshness — which is the
      // only way "nothing matched" can be told apart from "nothing was read".
      ...(rows.length ? {} : { empty: true }),
      totalMentions: r.totalMentions || 0,
      results: rows,
      note: corpusClockNote(clock, { recencyVoid: !!r.recencyVoid })
    };
    for (const k of SECTION_KEYS) {
      if (WRAPPER_OWNED.has(k)) continue;
      if (r[k] !== undefined) section[k] = r[k];
    }
    // A corpus with NO INDEX ON DISK is a different state from an empty one, and it is the one
    // state where the section legitimately cannot carry the rest of the contract. Say so, so a
    // reader (and (a75)) can tell the two apart instead of inferring it from missing keys.
    if (!idxPresent) {
      section.indexMissing = true;
      // 🟥 MEM-47: "no index" stopped implying "nothing was read". When ensureFresh armed the
      // direct read, these rows came from store files, so the note has to say BOTH -- a reader who
      // sees rows under a heading that claims the corpus was unreadable learns the wrong thing,
      // and (a75) asserts this note names the missing index either way.
      // `r.note` is only the honest whole answer when nothing WAS read: once the direct read has
      // run, latestIn's own note ("no document mentions every term") would silently drop the fact
      // that there is no index at all -- so the missing index is stated FIRST and its note follows.
      const readAnyway = rows.length || Number(r.unindexedChecked?.total) > 0;
      // 🟥 MEM-85: 0 corpus files is not "no index on disk, so nothing was ranked" — there was
      // nothing to rank. ensureFresh wrote the one honest line; say THAT here.
      section.note = r.empty === true
        ? String(r.emptyNote || 'this corpus holds 0 files')
        : readAnyway
        ? `${r.indexCorrupt ? `The index file for '${corpus}' exists but is unreadable (truncated or corrupt)` : `There is no index on disk for '${corpus}'`}, so nothing here was RANKED: what is here was ` +
          `read DIRECTLY from the files no index has seen yet. ${r.note || section.note}`
        : (r.note || 'no index for this scope');
    }
    sections.push(section);
    total += r.totalMentions || 0;

    builtByScope[corpus] = r.indexBuiltAt ?? null;
    byScope[corpus] = r;
    if (r.recencyVoid) recencyVoidByScope[corpus] = r.recencyVoid;
    if (r.unindexedChecked) unindexedByScope[corpus] = r.unindexedChecked;
    if (r.recencyVoid || r.foundInUnindexed || r.indexStale ||
        (r.unindexedChecked && r.unindexedChecked.total > 0)) notFullyRead.push(corpus);
    for (const g of (r.guidance || [])) {
      if (HOIST_GUIDANCE.some((re) => re.test(g))) topG.push(`[${corpus}] ${g}`);
    }
  }

  const answered = sections.some((s) => (s.results || []).length);
  const cfgWarnLatest = configWarning();
  const fresh = aggregateFreshness(names, (s) => byScope[s], { where: (s) => `the '${s}' section` });
  return guardValue(refuseGlobalNoIndexClaim({
    query, mode: 'latest', scope: requested,
    merged: false,
    totalMentions: total,
    // The stamp, aggregated exactly as search() aggregates it.
    indexBuiltAt: builtByScope.curated ?? builtByScope[names[0]] ?? null,
    indexBuiltAtByScope: builtByScope,
    indexStale: fresh.staleAny,
    staleFiles: fresh.staleAny ? fresh.staleFiles : 0,
    ...(fresh.staleWarning ? { staleWarning: fresh.staleWarning } : {}),
    // MEM-81, the `latest` half: the sections already carried it (SECTION_KEYS), but a reader of
    // the top level — the level the warning's own text addresses — saw nothing.
    ...(cfgWarnLatest ? { configWarning: cfgWarnLatest } : {}),
    ...(opts.brief ? { briefNote: BRIEF_NOTE } : {}),
    serverVersion: serverVersionString(),
    serverStartedAt: SERVER_STARTED_AT,
    // THE CHECK HAPPENED, VISIBLY, AT THE LEVEL A CALLER READS FIRST. Present only when some
    // corpus had something to check, so a wrapper over current indexes is unchanged.
    ...(Object.keys(unindexedByScope).length ? { unindexedChecked: {
      scanned: Object.values(unindexedByScope).reduce((n, u) => n + (u.scanned || 0), 0),
      total: Object.values(unindexedByScope).reduce((n, u) => n + (u.total || 0), 0),
      merged: Object.values(unindexedByScope).reduce((n, u) => n + (u.merged || 0), 0),
      byScope: unindexedByScope
    } } : {}),
    ...(Object.keys(recencyVoidByScope).length ? { recencyVoidByScope } : {}),
    ...(topG.length ? { guidance: topG } : {}),
    note: answered
      ? 'NOT MERGED, BY DESIGN — THE CORPORA DO NOT SHARE A CLOCK. Each section is ordered by ' +
        'its own, and says which. Blending them is measured harm here: mixing staging into ' +
        'curated cost 3 memories their answer and dropped MRR 0.826 -> 0.681. Compare the ' +
        'sections instead — the standing rule vs. the last conversation — that difference is ' +
        'usually the answer.'
      // A ZERO IS ONLY AN ABSENCE IF EVERYTHING WAS READ. Before this, an array scope over a stale
      // staging index reported "No document in any corpus mentions every term" while its own
      // sections held the evidence that the corpora had not been fully read.
      : (notFullyRead.length
        ? `NOT AN ABSENCE — THESE CORPORA WERE NOT FULLY READ: ${notFullyRead.join(', ')}. No INDEXED ` +
          'document mentions every term, but the index is behind the store in the corpora named, so ' +
          'this is not evidence that nothing was said. Read each section\'s unindexedChecked, ' +
          'recencyVoid, foundInUnindexed and staleWarning, and the guidance above, before concluding ' +
          'anything is absent.'
        : 'No document in any corpus mentions every term. Drop a term and retry; latest() is a ' +
          'FILTER, not a ranker.'),
    sections,
    // Back-compat: a caller reading only .results still gets the time-ordered corpora
    // first, and every row says which corpus it came from.
    results: sections.filter((x) => x.orderedBy === 'ts')
      .concat(sections.filter((x) => x.orderedBy !== 'ts'))
      .flatMap((sec) => (sec.results || []).map((r) => ({ ...r, corpus: sec.corpus, orderedBy: sec.orderedBy })))
  }, 'latest scope:' + JSON.stringify(requested)), 'latest-all-output');
}

// ---- WHAT A LATEST RESPONSE MAY SAY BACK ABOUT THE QUERY -------------------------------------
//
// `latest` restates the caller's terms FOUR times: the echoed `query`, `unmatchableTerms`,
// `termWarning`, and the PREMISE NOT SUPPORTED line in `guidance` — plus `termFrequencies` and its
// whole-word twin, one entry per term. Every one of those is proportional to the input, so the
// response is a MULTIPLE of it. Measured 2026-09-05, deterministically, twice: a 1,048,600-byte
// query produced a 6,587,158-byte response (×6.28) — termWarning 1.93 MB, guidance 1.68 MB,
// unmatchableTerms 1.30 MB. `search`, which echoes the query once and nothing else, was ×1.01.
//
// Two bounds, because they fail in different places. The schema bound (tools/memory.js) stops an
// oversized query at the MCP door, which is the only door a client comes through. These stop the
// amplification itself, for every caller that reaches the function directly — the suite, the
// evaluation scripts, lib code — where zod never runs. Neither bound changes any real query: 512
// characters is longer than any query in the log, and 200 terms is longer than any sentence.
const QUERY_ECHO_CHARS = 512;
const MAX_LATEST_TERMS = 200;

/** The echoed query, bounded, with the true length beside it when it was cut. */
function queryEcho(q) {
  const s = String(q ?? '');
  if (s.length <= QUERY_ECHO_CHARS) return { query: q };
  return {
    query: s.slice(0, QUERY_ECHO_CHARS),
    queryChars: s.length,
    queryEchoTruncated: `the echo above is the first ${QUERY_ECHO_CHARS} characters of a ` +
      `${s.length}-character query. You sent it; this response does not need to send it back.`
  };
}

export async function latest(query, opts = {}) {
  const { limit = 5, scope = 'staging', sessionId = null, account = null, project = null,
          includeSummaries = true, brief = false } = opts;
  // One id per caller question: the fan-out threads `_queryId`; a real MCP request supplies its own
  // (lib/config.js beginMcpRequest) so the handler's `kind:'response'` row joins every query row.
  const queryId = opts._queryId || requestContext()?.queryId || newQueryId();
  if (isMultiScope(scope)) return latestAll(query, { ...opts, scope, _queryId: queryId });

  const allTerms = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];
  // Capped, not rejected: a caller who pastes a document as a query still gets an answer, and is
  // told which part of it was used. `browse` (no terms at all) is unaffected either way.
  const terms = allTerms.length > MAX_LATEST_TERMS ? allTerms.slice(0, MAX_LATEST_TERMS) : allTerms;
  const termsIgnored = allTerms.length - terms.length;
  // ---- NEWEST-N WITHOUT TERMS -----------------------------------------------------------
  //
  // `latest` used to return `{note:'no usable terms'}` BEFORE ensureFresh ran — so the one
  // question a memory server is most often asked, "what have we been working on", had no answer at
  // all: the caller had to already know a word from the thing they were trying to recall. Worse,
  // the early return skipped the freshness check, so the emptiest possible response was also the
  // only one that never said the index was behind the store.
  //
  // Browse mode keeps EVERY filter except the AND (sessionId, account, project, includeSummaries,
  // summary demotion), and keeps the two guards that matter most here: the direct read of
  // unindexed store files and the recency void. A "what happened lately" question is precisely
  // where a file the index has not seen is the answer.
  const browse = !terms.length;
  // The MCP schema caps `limit` at 50, but this function is also called directly (lib, suite,
  // evaluation scripts) where zod never runs. A browse of 5,000 exchanges is not a browse.
  if (browse && opts.limit !== undefined && Number(opts.limit) > 50) {
    throw new Error(`latest browse mode is capped at 50 rows (asked for ${opts.limit}). ` +
      'Narrow it with sessionId/account/project, or pass a query to filter by term.');
  }
  const rowLimit = browse ? Math.min(Number(opts.limit ?? 10), 50) : limit;

  // CHECK THE INDEX AGAINST THE CORPUS BEFORE ANSWERING FROM IT -- the same guard
  // search() has had, which latest() shipped without.
  //
  // The irony was exact: latest() is the action MOST damaged by staleness, because
  // new material is precisely what a stale index lacks. Ask "what is the latest on
  // X" right after a conversation about X and the answer could omit that whole
  // conversation while looking authoritative. Observed live: the staging index was
  // built at 01:30, the Stop hook ingested at 15:57, 59 files changed in between --
  // search() named eight of them and gave the fix command, latest() said nothing.
  //
  // ensureFresh may rebuild inline, but only where that is cheap: reindexInline's
  // file-count bound refuses a 2,317-document staging rebuild (~14 s / ~140 MB), so
  // this reports the staleness rather than making a query wait for it.
  const { idx, stamp } = await ensureFresh(scope);
  // 🟥 AN ABSENT INDEX IS NOT AN ABSENT CORPUS (MEM-47 / A-D2). This return used to be
  // unconditional, so on a fresh install every `latest` was answered by the ONE branch of
  // ensureFresh that reads nothing -- 0 rows over store files that held the answer. When
  // ensureFresh has armed the direct read (`stamp._staleScan`, see its no-index branch) those
  // files are answerable and latestIn() below reads them; `idx.docs` is empty, so the ONLY thing
  // this can return is what the store says, each row labelled `provenance:'unindexed-direct'`.
  if (!idx.present && !(stamp._staleScan || []).length) {
    // 🟥 MEM-85: 'no index for this scope' is true of both states and useless in the one that is
    // reached most — a fresh install whose store is still empty. When ensureFresh classified this
    // corpus as EMPTY it already wrote the honest line; use it rather than restate half of it.
    // Nothing was read, so there are no rows for brief to trim — the note still rides, because a
    // caller that asked for brief and got a bare envelope should be told the flag was honoured.
    const bare = { ...queryEcho(query), mode: 'latest', scope, results: [], ...stamp,
      note: stamp.empty === true ? String(stamp.emptyNote) : 'no index for this scope' };
    return brief ? briefRows(bare, { top: !opts._nested }) : bare;
  }

  // ONE copy of the alias/array rule, shared with search(). latest() used to
  // re-implement it with `doc.account !== account`, which matched nothing when the
  // caller passed an array and never resolved 'mine'/'this' at all.
  const { wantAccounts, wantProjects } = resolveFilters({ account, project });

  const when = (d) => Date.parse(d.ts || d.modified || 0) || 0;
  const hits = [];
  // Document frequency PER TERM, counted in the same pass. latest() is an AND
  // filter, so one term nobody uses takes the whole query to zero -- and the bare
  // zero looks exactly like "this never happened". Naming the term turns a dead
  // end into the next query. (Reported only, never dropped automatically: the term
  // that matches nothing is often the one that mattered, and silently relaxing the
  // filter would answer a question the caller did not ask.)
  const df = new Map(terms.map((t) => [t, 0]));
  // 🟥 SUBSTRING MATCHING IS DELIBERATE — it is what makes `v111` find `release-v111-shipped` and a
  // SHA find the exchange that cites it. What was NOT deliberate is REPORTING it as a term
  // count. Measured 2026-09-02: latest("Rust") returned totalMentions 509 with three results
  // dated today, one carrying a git-VERIFIED commit, under "results[0] is the last thing said
  // about this" — and every single match was the word `trust`. latest("Redis") returned 12,
  // all `rediscovers`. Asked about work that never happened, it manufactured recent,
  // specific, commit-corroborated evidence for it.
  //
  // So: count whole-word matches too, and when a term matches ONLY inside other words, say so.
  // This is an observation, not a judgement — it changes no filtering and no ordering.
  const dfWord = new Map(terms.map((t) => [t, 0]));
  const wordRe = new Map(terms.map((t) => [t, new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')]));
  const partial = [];   // every doc matching at least one term, for the relaxed fallback
  let summariesDemoted = 0;
  // THE STORE IS TRUTH. Files the index has not read yet (stamp._staleScan, staging only — curated
  // repairs itself inline) are read DIRECTLY and run through the SAME filter below, so an exchange
  // captured seconds ago is answerable before any rebuild. When nothing is unindexed `direct.docs`
  // is empty and this loop is byte-for-byte what it was. See lib/unindexed.js.
  const direct = readUnindexed(stamp);
  for (const doc of mergeDirect(idx.docs, direct.docs)) {
    if (sessionId && doc.sessionId !== sessionId) continue;
    if (wantAccounts && doc.account && !wantAccounts.has(doc.account)) continue;
    if (wantProjects && doc.project && !wantProjects.has(doc.project)) continue;
    const summary = isCompactionSummary(doc);
    if (summary && includeSummaries === false) continue;
    // BROWSE: no terms, so there is no AND to apply and no document frequency to count. Every
    // other filter above has already run, and the sort below is the same sort.
    if (browse) {
      if (summary) summariesDemoted++;
      hits.push({ doc, when: when(doc), summary });
      continue;
    }
    const hay = (doc.name + ' ' + (doc.description || '') + ' ' + bodyOf(doc)).toLowerCase();
    const matched = terms.filter((t) => hay.includes(t));
    for (const t of matched) {
      df.set(t, df.get(t) + 1);
      if (wordRe.get(t).test(hay)) dfWord.set(t, dfWord.get(t) + 1);
    }
    if (matched.length) partial.push({ doc, when: when(doc), matched, n: matched.length, summary });
    // every term, so this stays a FILTER and does not drift into fuzzy ranking
    if (matched.length !== terms.length) continue;
    if (summary) summariesDemoted++;
    hits.push({ doc, when: when(doc), summary });
  }
  // Primary sources first, THEN summaries -- each half still strictly newest-first.
  hits.sort((a, b) => (a.summary === b.summary ? b.when - a.when : (a.summary ? 1 : -1)));

  // RELAXED FALLBACK -- only when the strict AND found NOTHING.
  //
  // The plan called this "optional and riskier" and shipped only the naming half.
  // Then the test that was supposed to validate the naming half sent 2 of 6 real
  // questions to zero, and the top hit for a third turned out to be an EARLIER
  // session writing down this exact fix: "Every-term AND is brittle. Fix: fall
  // back to most-terms-matched when the strict AND returns nothing, and say which
  // term was dropped." Taking the corpus's own advice.
  //
  // The risk is real and it is why this NEVER runs when the strict filter found
  // something: a dropped term is often the term that mattered. So it fires only
  // where the alternative is an empty answer, keeps the documents matching the
  // MOST terms (not an arbitrary count), and names every term it gave up on.
  let relaxed = false;
  let droppedTerms = [];
  if (!hits.length && partial.length && terms.length > 1) {
    const best = Math.max(...partial.map((x) => x.n));
    const kept = partial.filter((x) => x.n === best)
      .sort((a, b) => (a.summary === b.summary ? b.when - a.when : (a.summary ? 1 : -1)));
    // INTERSECTION, not union. The union let `relaxed: true` ship with
    // `droppedTerms: []` -- incoherent, and observed in the six-question test:
    // the kept documents collectively covered every term while no single one did.
    droppedTerms = terms.filter((t) => !kept.every((x) => x.matched.includes(t)));
    hits.push(...kept);
    relaxed = true;
  }

  const unmatchableTerms = terms.filter((t) => df.get(t) === 0);
  const rarest = terms.filter((t) => df.get(t) > 0).sort((a, b) => df.get(a) - df.get(b))[0];
  const termNote = !hits.length && !relaxed && terms.length > 1
    ? (unmatchableTerms.length
        ? `NO DOCUMENT CONTAINS ${unmatchableTerms.map((t) => JSON.stringify(t)).join(' or ')} — ` +
          `that term alone took this AND-filter to zero. Retry without it: ` +
          `memory({action:"latest", query:"${terms.filter((t) => !unmatchableTerms.includes(t)).join(' ')}"}).`
        : `Every term appears somewhere, but never all together. The rarest is ${JSON.stringify(rarest)} ` +
          `(${df.get(rarest)} documents) — drop that one first, or use action:"search", which ranks ` +
          'rather than filtering.')
    : null;

  // A filter that eliminates EVERYTHING because the corpus does not carry that
  // label at all is indistinguishable, from the outside, from "nothing happened".
  // Measured: `project:'this'` resolves to the Claude-projects slug, which is
  // exactly how the 123 CURATED docs are labelled -- but latest() defaults to
  // STAGING, where all 2,317 docs are labelled 'store'. The filter is right and
  // the zero is honest; it was just SILENT, which is the failure this whole file
  // is being changed to stop. So name it, and name what the corpus does carry.
  const filterNotes = [];
  const noneCarry = (key, want) => want && !idx.docs.some((d) => d[key] && want.has(d[key]));
  for (const [key, want, arg] of [['project', wantProjects, 'project'], ['account', wantAccounts, 'account']]) {
    if (!noneCarry(key, want)) continue;
    const seen = [...new Set(idx.docs.map((d) => d[key]).filter(Boolean))].slice(0, 6);
    filterNotes.push(
      `FILTER MATCHED NOTHING — NOT AN EMPTY CORPUS. No document in scope '${scope}' carries ` +
      `${key} ${[...want].map((v) => JSON.stringify(v)).join(', ')}. This corpus labels its ` +
      `documents ${seen.length ? seen.map((v) => JSON.stringify(v)).join(', ') : '(nothing)'}. ` +
      `Retry without \`${arg}\`, or with one of those values.`);
  }

  const results = hits.slice(0, rowLimit).map(({ doc, when: w }) => withThreadPosition({
    name: doc.name, file: doc.file, account: doc.account || null, project: doc.project || null,
    sessionId: doc.sessionId || null, sessionTitle: doc.sessionTitle || null,
    ts: doc.ts || doc.modified || null,
    // AROUND THE MATCH, not the tail of the document. The tail was actively
    // misleading: a 17,608-char exchange that mentions a term once, in passing,
    // showed a snippet from a completely different subject -- and because it was
    // also the NEWEST document containing every term, it took first place on three
    // unrelated test questions. Same ordering, but now the row shows why it matched.
    snippet: guardValue(trimSnippet(matchSnippet(bodyOf(doc), terms, df)), 'latest-snippet'),
    termHits: countHits(bodyOf(doc), terms),
    ...(isCompactionSummary(doc) ? { isCompactionSummary: true } : {}),
    // READ FROM THE STORE, NOT THE INDEX. The row is current; it has no thread position (the
    // thread map is built from the index) and no ranking score (latest never had one).
    ...(doc.unindexed ? { provenance: 'unindexed-direct' } : {}),
    // Same flag search() rows carry (search.js ~:1160). `latest` — the action whose whole job is
    // "what happened most recently" — was the one that never said a row was still being written.
    ...(doc.inFlight ? { inFlight: true, inFlightNote: 'This exchange was STILL BEING WRITTEN when it was captured — the assistant had not finished replying. Treat it as a draft, not the last word; the finished version replaces it on the next capture.' } : {}),
    links: doc.links
  }, idx));

  // VERIFICATION, NOT INFERENCE. "Did this finish?" is a question about the world,
  // and for engineering claims the world keeps a record: the commit. Where a row
  // cites a SHA that really exists, the row now carries the date, the subject and
  // whether it landed on the mainline -- so a claim can be CHECKED rather than
  // read. Silent no-op unless MEMORY_GIT_REPOS is configured.
  await attachCommits(results, hits.slice(0, rowLimit).map(({ doc }) => bodyOf(doc)));
  const verifiedRows = results.filter((r) => r.verifiedCommits).length;

  // ONE field name for advice, the same one search() uses, instead of a single
  // `note` string that a caller has to parse prose out of. `note` is kept because
  // the query log captures payloads and old rows are still read.
  // ABSENCE VERDICT — the half latest() shipped without.
  //
  // search() has had one since v1.1; latest() returned whatever the filter matched
  // and let the caller infer the rest. Measured with five pre-registered FALSE
  // premises ("the Tier 3 dream resolution arm shipped", "MEMORY_CURRENCY_REPOS
  // implemented" — none of which happened): all five returned rows, none said so,
  // and one returned 75 relaxed matches whose top snippet read like confirmation.
  //
  // For a memory system that is the worst possible failure: not missing an answer,
  // but manufacturing one. So say plainly whether the query AS PHRASED appears
  // anywhere, and never let a relaxed match stand in as evidence that it does.
  const premiseSupported = hits.length > 0 && !relaxed;
  const guidance = [];
  const collision = staleTermCollision(unmatchableTerms, stamp);
  if (collision) guidance.push(collision);
  // Filename first (cheap, exact), then content. The content scan only reads
  // anything when the filename pass found nothing and a term is still unmatchable.
  const unindexed = collision ? null : staleContentScan(unmatchableTerms, stamp);
  if (unindexed) guidance.unshift(unindexed.note);
  // C2 -- the query named an identifier that exists in no configured repo.
  // Runs here rather than waiting to be asked, because the caller who most
  // needs this is the one who does not suspect anything is wrong.
  const autoIdent = await autoVerifyQuery(query);
  if (autoIdent) guidance.push('NOT IN THE CODE — ' + autoIdent.note);
  if (!premiseSupported && terms.length > 1) {
    guidance.push('PREMISE NOT SUPPORTED — no single document contains all of ' +
      terms.map((t) => JSON.stringify(t)).join(', ') + '. ' +
      (relaxed
        ? 'What follows matched only SOME of those terms, so it is NOT evidence that the thing ' +
          'you asked about happened. Treat it as related reading, not as confirmation.'
        : 'Nothing matched at all.') +
      ' If you are checking whether something is true, this is the answer: the corpus does not ' +
      'say so. Absence here is weak evidence — it may have happened without being written down ' +
      '(measured: only 2 of 12 commits made in one session were named in that session\'s text) — ' +
      'but it is NEVER support for the claim.');
  }
  if (summariesDemoted) {
    guidance.push(`${summariesDemoted} MATCHING exchange(s) are CONTEXT-COMPACTION SUMMARIES ` +
      '(isCompactionSummary) and were sorted BELOW every first-hand exchange, so they may fall ' +
      'outside this limit entirely. A summary restates a whole conversation, so it matches ' +
      'nearly any query while carrying a recent timestamp for old content — it can still answer, ' +
      'but it is a restatement, not the last word. Pass includeSummaries:false to drop them.');
  }
  if (relaxed) {
    guidance.push(`RELAXED FILTER — no document contained all ${terms.length} terms, so these ` +
      `matched the most that any document did. DROPPED: ${droppedTerms.map((t) => JSON.stringify(t)).join(', ')}. ` +
      'A dropped term is often the term that mattered, so check these are about what you asked ' +
      'before trusting the ordering.');
    // The measured cause of nearly every relaxed query in the six-question test:
    // the query was PROSE and the corpus is written in IDENTIFIERS. "did the
    // reparse finish" and "pushed commit with failing test semicolon" both failed;
    // "pushed c509e0f" and "max-old-space-size heap 20000 rows" returned the exact
    // answer from the same corpus. A term filter matches strings, so the words that
    // work are the ones the work itself was written in.
    // DOMAIN-AWARE. This used to say "RETRY WITH IDENTIFIERS, NOT PROSE" to every
    // caller, which is measured advice — on a CODE corpus. Told to someone whose
    // memories are notes for a novel it inverts: they have no SHAs, no flags and no
    // paths, and prose is the only thing they CAN search with. Stating a
    // corpus-specific finding as a universal rule misleads a new user on their
    // first query, so the advice now follows the corpus, the query shape, or an
    // explicit domain the caller names.
    const adv = adviceFor({ query, corpusDomain: (idx.profile || {}).domain, hint: opts.domain });
    guidance.push('RETRY DIFFERENTLY — ' + adv.advice + ` (advice basis: ${adv.basis})`);
  }
  if (verifiedRows) {
    const landed = results.flatMap((r) => r.verifiedCommits || []).filter((c) => c.onMainline).length;
    guidance.push(`${verifiedRows} of these rows cite commits that were VERIFIED IN GIT ` +
      `(${landed} on the mainline) — see verifiedCommits. That is the record, not the wording: ` +
      'a row saying work was committed is confirmed by the commit existing, and a row with no ' +
      'verifiedCommits cited no SHA (which proves nothing either way).');
  }
  // ---- THE RECENCY PROMISE, CHECKED AGAINST THE CLOCK ----------------------
  //
  // `latest` exists to answer "what is the last word on X". It ranks what the INDEX holds. When
  // the index is stale, it used to rank anyway and still say "results[0] is the last thing said
  // about this" — with the count of unread files sitting in the same response.
  //
  // The observed failure: the answer lived in a store file written at 17:02, the index had been
  // built at 00:24, the response reported indexStale with 25 stale files, and then returned a
  // drafting session from the PREVIOUS DAY as results[0] under that sentence. The five files
  // holding the real answer were named in its own warning and absent from its results.
  //
  // 🟥 WHY THIS IS NOT staleTermCollision OR staleContentScan. Both of those fire only when a
  // term is UNMATCHABLE. Here nothing was unmatchable — the query matched plenty of documents,
  // just older ones — so neither could fire. Those guards check TERMS; this one checks TIME, and
  // that is the whole difference.
  //
  // 🟥 AND WHY IT IS ADDITIVE. It runs after autoVerifyQuery, corpusCurrency and the guidance
  // array are assembled, and removes none of them. An early return here would silently disable
  // the git "is this still true?" layer — trading one wrong-answer bug for another.
  // 🟥 NARROWED (Daniel, 2026-09-05): with lib/unindexed.js reading the stale files DIRECTLY and
  // running them through the filter above, a stale file that was read and did not match is honestly
  // not the answer — the same as an indexed non-match — and warning about it would be noise. So the
  // void is measured over the files this call could NOT vouch for: past the read bound, or
  // unreadable. With the kill switch off (MEMORY_UNINDEXED_DIRECT=0) nothing is read, every stale
  // file is unvouched, and this is exactly the MEM-1 guard it was.
  const directMerged = results.filter((r) => r.provenance === 'unindexed-direct').length;
  if (directMerged) guidance.unshift(unindexedGuidance(directMerged, { merged: true }));
  let recencyVoid = null;
  try {
    const newestUnread = direct.enabled ? direct.unreadNewestMs : stamp._staleNewestMs;
    const topTs = results[0]?.ts ? Date.parse(results[0].ts) : NaN;
    if (stamp.indexStale && Number.isFinite(newestUnread) && Number.isFinite(topTs) && newestUnread > topTs) {
      const files = direct.enabled
        ? direct.unreadNewestFiles
        : [...(stamp.staleFilesAdded || []), ...(stamp.staleFilesChanged || [])];
      recencyVoid = {
        newestUnindexedModified: new Date(newestUnread).toISOString(),
        newestRankedAt: results[0].ts,
        unreadFiles: files.slice(0, 15),
        unreadFileCount: direct.enabled
          ? (direct.total - direct.scanned) + direct.unreadable
          : (stamp.staleFiles ?? files.length)
      };
      guidance.unshift(
        `NEWEST-FIRST CANNOT BE HONOURED — ${recencyVoid.unreadFileCount} file(s) this index has not ` +
        `read were modified as recently as ${recencyVoid.newestUnindexedModified}, which is NEWER than ` +
        `the newest row it can rank (${recencyVoid.newestRankedAt}). results[0] is therefore NOT ` +
        'the last word. READ THESE FIRST: ' + recencyVoid.unreadFiles.join(', ') +
        (files.length > 15 ? `, …and ${files.length - 15} more` : '') + '.');

      // 🟥 AND SAY WHICH OF THEM WAS STILL BEING WRITTEN.
      //
      // This warning is followed — that is the point of it. On 2026-09-04 another session did
      // exactly as told, opened the newest unread file, and reported a finding that the very same
      // answer went on to retract seven minutes later. It had done everything right. Nothing here
      // distinguished "newest" from "unfinished", and a hook captures the final exchange even
      // mid-reply on purpose (deferring it there loses the last exchange of every session — a
      // transcript quiet for 15 minutes leaves the timer's window and is never revisited).
      //
      // Reading the head of each named file is cheap (a few KB, at most 15 files) and only happens
      // on a query that already found a recency void. Fail quiet: an unreadable file is simply not
      // flagged, which leaves the warning exactly as strong as it was before.
      try {
        const drafts = [];
        for (const rel of recencyVoid.unreadFiles) {
          try {
            const abs = isAbsolute(rel) ? rel : join(dirname(indexPathForCorpus(scope)), rel);
            if (/^\s*inFlight:\s*true\s*$/m.test(readFileSync(abs, 'utf8').slice(0, 4096))) drafts.push(rel);
          } catch { /* unreadable: leave it unflagged */ }
        }
        if (drafts.length) {
          recencyVoid.stillBeingWritten = drafts;
          guidance.unshift(
            `🟥 ${drafts.length} of those unread file(s) were STILL BEING WRITTEN when captured — the ` +
            'assistant had not finished replying: ' + drafts.join(', ') + '. Read them as DRAFTS. ' +
            'A conclusion in one of them may be retracted later in the same answer; the finished ' +
            'version replaces the file on the next capture.');
        }
      } catch { /* the warning above still stands */ }
    }
  } catch { recencyVoid = null; }

  if (hits.length) {
    // 🟥 THE CLAIM APPEARS TWICE — here and in `note`. A first version of this guard fixed only
    // `note`, and the response then CONTRADICTED ITSELF: guidance[0] said newest-first could not
    // be honoured while a later guidance line still said results[0] was the last word. Found by
    // reading a real response, not by reasoning about the diff.
    guidance.push(recencyVoid
      ? 'Ordered NEWEST FIRST by ' + corpusClockPhrase(corpusClock(idx)) +
        ' — but ONLY over what is indexed, and unread files are newer. results[0] is NOT the last word here.'
      : 'Ordered NEWEST FIRST by ' + corpusClockPhrase(corpusClock(idx)) +
        '. results[0] is the last thing said about this.');
    const top = results[0];
    if (top && top.laterInThread > 0) {
      guidance.push(`But results[0] is ${top.threadPosition} of its thread — the newest exchange ` +
        `MENTIONING these terms is not the newest exchange in the conversation. ` +
        `memory({action:"get", name:"${top.threadLast}"}) is where that thread actually ends.`);
    }
    // THE LAST-WORD CAVEAT IS NOW CONDITIONAL. It used to fire on every call, and
    // measuring the result showed why that was wrong: guidance averaged 1,607 chars
    // over six real queries, so the lines that MATTER (premise unsupported, relaxed
    // filter) were buried among lines that are always there. The caveat is also in
    // the tool description, which is loaded once per session, so repeating it in
    // full on every response bought nothing.
    //
    // It now fires when there is an actual gap to warn about: the corpus is behind
    // the repos, or the newest matching exchange is over two days old. Same rule
    // applied to the cry-wolf warnings earlier today -- say it when it is true, not
    // as decoration.
    const newestHit = Date.parse(results[0]?.ts || 0) || 0;
    const staleHours = newestHit ? (Date.now() - newestHit) / 3600000 : 0;
    if (staleHours > 48) {
      guidance.push('THE LAST WORD IS NOT CURRENT TRUTH — and the newest match here is ' +
        Math.round(staleHours / 24) + ' days old. This is the last thing SAID about it, not the ' +
        'last thing that HAPPENED. Check the world (git log, the filesystem, the running process) ' +
        'before reporting it as current state.');
    }
  }

  // Logged like search is, so the mode split answers "is the guidance changing
  // behaviour?" -- previously `latest` was invisible to the log entirely, which
  // made that question unanswerable by the one instrument that could answer it.
  // CORPUS CURRENCY. The guidance already says the last word is not current truth;
  // a sentence is easy to skip and a COUNT is not. Emitted here rather than in a
  // report nobody reads, because `latest` is the action that claims to give the
  // last word, so this is exactly where over-trusting it does the damage.
  let currency = null;
  try {
    currency = idx.newestTs ? await cachedCorpusCurrency(new Date(idx.newestTs).toISOString()) : null;
  } catch { currency = null; }
  if (currency && currency.commitsSince.some((r) => r.commitsSince > 0)) guidance.push(currency.note);

  // Report the divergence BEFORE the newest-first framing, because that framing is what makes
  // a substring artefact read as a finding.
  const insideOnly = terms.filter((t) => df.get(t) > 0 && dfWord.get(t) === 0);
  const mostlyInside = terms.filter((t) => df.get(t) > 0 && dfWord.get(t) > 0 && dfWord.get(t) * 4 < df.get(t));
  if (insideOnly.length) {
    guidance.unshift(
      'MATCHED INSIDE OTHER WORDS, NOT AS A WORD — ' +
      insideOnly.map((t) => `"${t}" appears in ${df.get(t)} document(s) but in NONE of them as a ` +
        'separate word (it is inside a longer word)').join('; ') +
      '. Treat the count and these results as evidence of NOTHING about that term until you have ' +
      'read a snippet and seen the word itself.');
  } else if (mostlyInside.length) {
    guidance.push('MOSTLY INSIDE OTHER WORDS — ' + mostlyInside.map((t) =>
      `"${t}": ${dfWord.get(t)} of ${df.get(t)} matches are the whole word`).join('; ') + '.');
  }

  logQuery({ query, mode: 'latest', scope, totalCandidates: hits.length,
    noStrongMatch: !hits.length, results }, { queryId });

  const briefLatest = (r) => (brief ? briefRows(r, { top: !opts._nested }) : r);
  return briefLatest(guardValue({
    ...queryEcho(query), mode: 'latest', scope,
    ...(termsIgnored ? { termsIgnored, termsUsed: terms.length,
      termsNote: `${allTerms.length} terms were parsed out of this query and only the first ` +
        `${terms.length} were used. Every field below describes THOSE terms.` } : {}),
    ...(browse ? { browse: true } : {}),
    ...stamp,
    orderedBy: corpusClock(idx),
    totalMentions: hits.length,
    guidance: guidance.length ? guidance : undefined,
    note: browse
      ? (recencyVoid
        ? `BROWSE MODE (no query terms): the ${results.length} newest of ${hits.length} document(s) in ` +
          `scope '${scope}' — but ${recencyVoid.unreadFileCount} unread file(s) are NEWER than results[0], ` +
          'so this is not the newest. Read recencyVoid.unreadFiles first.'
        : `BROWSE MODE (no query terms): the ${results.length} newest of ${hits.length} document(s) in ` +
          `scope '${scope}', newest first. This is a WINDOW, not an answer — nothing was filtered by ` +
          'topic, so a document being here means only that it is recent. Pass a query to filter by ' +
          'term, sessionId to read one conversation, or action:"sessions" for the conversations themselves.')
      : (hits.length
      // The claim is the defect, so the claim is what changes. Everything else in this response
      // is identical either way.
      ? (recencyVoid
        ? `Ordered NEWEST FIRST — but ${recencyVoid.unreadFileCount} unread file(s) are NEWER than ` +
          'results[0], so this is not the last word. Read the files in recencyVoid.unreadFiles ' +
          'before concluding anything about what happened most recently.'
        : 'Ordered NEWEST FIRST. results[0] is the last thing said about this. A thread that ' +
          'simply stops still reads as "in progress" — read the snippet before concluding it is done.')
      : 'No document mentions every term. Drop a term and retry; latest() is a FILTER, not a ranker.'),
    ...(recencyVoid ? { recencyVoid } : {}),
    ...(filterNotes.length ? { filterWarning: filterNotes.join(' ') } : {}),
    ...(unmatchableTerms.length ? { unmatchableTerms } : {}),
    ...(unindexed ? { foundInUnindexed: unindexed.foundInUnindexed } : {}),
    // THE CHECK HAPPENED, VISIBLY — present only when there was something to check, so a response
    // over a current index is byte-identical to before (that is the regression gate).
    ...(direct.total ? { unindexedChecked: {
      scanned: direct.scanned, total: direct.total, merged: directMerged,
      ...(direct.excluded ? { excluded: direct.excluded } : {}),
      ...(direct.truncated ? { truncated: true } : {}),
      ...(direct.enabled ? {} : { disabled: 'MEMORY_UNINDEXED_DIRECT=0' })
    } } : {}),
    // A BROWSE HAS NO PREMISE. `premiseSupported` answers "does the corpus say the thing you named?"
    // and nothing was named, so reporting `true` would be an answer to a question nobody asked.
    ...(browse ? {} : { premiseSupported }),
    corpusProfile: idx.profile ? { domain: idx.profile.domain, confidence: idx.profile.confidence,
      basis: idx.profile.overridden ? 'override' : 'derived', note: idx.profile.note } : undefined,
    ...(currency ? { corpusCurrency: currency } : {}),
    ...(relaxed ? { relaxed: true, droppedTerms, matchedTermsPerDoc: `${terms.length - droppedTerms.length} of ${terms.length}` } : {}),
    ...(summariesDemoted ? { summariesDemoted } : {}),
    ...(termNote ? { termWarning: termNote } : {}),
    termFrequencies: Object.fromEntries(df),
    // The same counts restricted to whole-word matches. A big gap between these two is the
    // difference between a real mention and a stemming artefact.
    termFrequenciesWholeWord: Object.fromEntries(dfWord),
    results
  }, 'latest-output'));
}

// ---- WHAT CONVERSATIONS EXIST? -------------------------------------------------------------
//
// Neither `search` nor `latest` can answer it. Both return EXCHANGES — one moment in one chat —
// and a caller who wants "which sessions have I had, and where did each one get to" had to guess
// a term, read rows, and reconstruct the grouping by hand from x-<sid8>-<ts> filenames. The
// grouping already exists: buildThreadMap() computes it per index and then throws the per-session
// view away, keeping only each exchange's position.
//
// This is a DIRECTORY, not retrieval. No ranking, no scoring, no judgement: group by sessionId,
// report the ends. Curated documents carry `originSessionId` in the same field, so the same walk
// answers "which conversations produced these memories".
//
// It folds in the store files the index has not read (`pendingIndex: true`) for the same reason
// `latest` does: a conversation that finished five minutes ago is exactly the one being asked
// about, and it is the one most likely to be missing from the index.

// Transcript directories, resolved the way scripts/auto-ingest.js:91-97 resolves them (env
// override first, then every ~/.claude/projects/<dir>). Cached for 60 s: this is a `readdir`
// on the answer path, and it must never be the reason a query fails.
let _transcriptDirs = { at: 0, dirs: null };
function transcriptDirsCached() {
  const now = Date.now();
  if (_transcriptDirs.dirs && now - _transcriptDirs.at < 60_000) return _transcriptDirs.dirs;
  let dirs = null;
  try {
    if (process.env.MEMORY_TRANSCRIPT_DIR) dirs = [process.env.MEMORY_TRANSCRIPT_DIR];
    else {
      const root = join(homedir(), '.claude', 'projects');
      dirs = readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(d));
    }
  } catch { dirs = null; }          // unreadable: the field is OMITTED, never guessed at
  _transcriptDirs = { at: now, dirs };
  return dirs;
}
export function _resetTranscriptDirCacheForTests() { _transcriptDirs = { at: 0, dirs: null }; }

// ---- THE DIRECT READ REPLACES THE INDEX COPY; IT DOES NOT SIT BESIDE IT ---------------------
//
// _staleScan is [...changed, ...added], so lib/unindexed.js reads CHANGED files as well as new
// ones — and a changed file is BY DEFINITION already in the index. Concatenating the two lists
// therefore returned the same document twice: the stale indexed copy and the current direct read,
// with nothing marking them as the same exchange. That is the ordinary case, not an edge one — the
// extractor rewrites an in-flight exchange the moment the reply finishes.
//
// Measured on a clean two-exchange corpus: touching one file took `sessions` count from 2 to 3 and
// put the same name in `latest` twice. A caller reading the older of the two believes it is a
// different exchange, which is the exact failure the direct read exists to prevent.
//
// The direct read is TRUTH — that is this whole mechanism's premise — so it wins. Keyed on
// `doc.file`, which docFieldsFromFrontmatter sets to the fileId on BOTH paths (lib/corpus.js:321,
// reached from lib/unindexed.js:132 as well as the indexer), so the two sides are comparable.
function mergeDirect(indexDocs, directDocs) {
  if (!directDocs.length) return indexDocs;
  const fresh = new Set(directDocs.map((d) => d.file));
  return [...indexDocs.filter((d) => !fresh.has(d.file)), ...directDocs];
}

function buildSessionMap(docs) {
  const out = new Map();
  for (const d of docs) {
    const sid = d.sessionId;
    if (!sid) continue;
    let s = out.get(sid);
    if (!s) {
      s = { sessionId: sid, sid8: String(sid).slice(0, 8), title: null, firstTs: null, lastTs: null,
            count: 0, lastExchange: null, lastInFlight: false, account: null, project: null,
            compactionSummaries: 0, _firstMs: Infinity, _lastMs: -Infinity, _firstDesc: null };
      out.set(sid, s);
    }
    s.count++;
    if (d.sessionTitle && !s.title) s.title = d.sessionTitle;
    if (d.account && !s.account) s.account = d.account;
    if (d.project && !s.project) s.project = d.project;
    if (isCompactionSummary(d)) s.compactionSummaries++;
    const t = Date.parse(d.ts || d.modified || 0) || 0;
    if (t && t < s._firstMs) { s._firstMs = t; s.firstTs = d.ts || d.modified || null; s._firstDesc = d.description || null; }
    if (t >= s._lastMs) { s._lastMs = t; s.lastTs = d.ts || d.modified || null; s.lastExchange = d.name; s.lastInFlight = !!d.inFlight; }
  }
  return out;
}

// Memoised beside `threads` on the per-scope cache entry, for the same reason: it is a pure
// function of the loaded index, and getIndex() throws the entry away whenever the index changes.
function sessionMapFor(idx) {
  if (!idx._sessionMap) {
    Object.defineProperty(idx, '_sessionMap', {
      value: buildSessionMap(idx.docs || []), enumerable: false, configurable: true, writable: true
    });
  }
  return idx._sessionMap;
}

export async function sessions({ scope = 'staging', limit = 20, account = null, project = null, sessionId = null } = {}) {
  const { idx, stamp } = await ensureFresh(scope);
  if (!idx.present) {
    return { mode: 'sessions', scope, ...stamp, sessions: [], total: 0,
      note: `No index for scope '${scope}', so there is nothing to group. This is not "no conversations".` };
  }
  const { wantAccounts, wantProjects } = resolveFilters({ account, project });

  // Start from the memoised index grouping, then FOLD IN the store files the index has not read.
  // A brand-new session that exists only in unindexed files must appear — it is the likeliest
  // subject of the question.
  const direct = readUnindexed(stamp);
  // The same dedup as latest(), in the shape this function needs. Its map is keyed by SESSION, not
  // by file, so folding a direct doc in on top of its own stale index copy ADDED to the count
  // instead of replacing it. When a direct doc shadows an indexed one the base is rebuilt from the
  // deduped doc list; when nothing is shadowed — the ordinary path — the memoised per-index map is
  // used exactly as before, so this costs nothing until it is needed.
  const fresh = new Set(direct.docs.map((d) => d.file));
  const shadowed = fresh.size > 0 && (idx.docs || []).some((d) => fresh.has(d.file));
  const base = shadowed
    ? buildSessionMap((idx.docs || []).filter((d) => !fresh.has(d.file)))
    : sessionMapFor(idx);
  let merged = base;
  const pending = new Set();
  if (direct.docs.length) {
    merged = new Map();
    for (const [k, v] of base) merged.set(k, { ...v });
    for (const [k, v] of buildSessionMap(direct.docs)) {
      pending.add(k);
      const prev = merged.get(k);
      if (!prev) { merged.set(k, v); continue; }
      prev.count += v.count;
      prev.compactionSummaries += v.compactionSummaries;
      prev.title = prev.title || v.title;
      prev.account = prev.account || v.account;
      prev.project = prev.project || v.project;
      if (v._firstMs < prev._firstMs) { prev._firstMs = v._firstMs; prev.firstTs = v.firstTs; prev._firstDesc = v._firstDesc; }
      if (v._lastMs >= prev._lastMs) { prev._lastMs = v._lastMs; prev.lastTs = v.lastTs; prev.lastExchange = v.lastExchange; prev.lastInFlight = v.lastInFlight; }
    }
  }

  const dirs = transcriptDirsCached();
  const rows = [...merged.values()]
    .filter((s) => (!sessionId || s.sessionId === sessionId) &&
                   (!wantAccounts || !s.account || wantAccounts.has(s.account)) &&
                   (!wantProjects || !s.project || wantProjects.has(s.project)))
    .sort((a, b) => b._lastMs - a._lastMs);
  const total = rows.length;
  const cap = Math.max(1, Math.min(Number(limit) || 20, 200));

  const outRows = rows.slice(0, cap).map((s) => {
    const row = {
      sessionId: s.sessionId, sid8: s.sid8,
      title: s.title || s._firstDesc || null,
      firstTs: s.firstTs, lastTs: s.lastTs, count: s.count,
      lastExchange: s.lastExchange, lastInFlight: s.lastInFlight,
      account: s.account, project: s.project,
      compactionSummaries: s.compactionSummaries
    };
    if (pending.has(s.sessionId)) row.pendingIndex = true;
    // WHETHER THE SOURCE STILL EXISTS. A session whose transcript is gone can never be
    // re-captured, however incomplete the store copy is. Omitted entirely when the transcript
    // directories are unreadable — a guess here would be worse than silence.
    if (dirs) {
      try { row.transcriptExists = dirs.some((d) => existsSync(join(d, `${s.sessionId}.jsonl`))); }
      catch { /* leave the field off */ }
    }
    return row;
  });

  const flightN = outRows.filter((r) => r.lastInFlight).length;
  const pendN = outRows.filter((r) => r.pendingIndex).length;
  return guardValue({
    mode: 'sessions', scope, ...stamp,
    total,
    sessions: outRows,
    note: `${total} conversation(s) in scope '${scope}', newest activity first` +
      (total > outRows.length ? `; showing ${outRows.length} (raise \`limit\`)` : '') + '. ' +
      'This is a DIRECTORY, not content: read one with memory({action:"thread", name:"<lastExchange>"}), ' +
      'or filter retrieval with sessionId. ' +
      (pendN ? `${pendN} of these carry exchanges the index has NOT read yet (pendingIndex) — they were ` +
        'read straight from the store. ' : '') +
      (flightN ? `${flightN} ended on an exchange that was STILL BEING WRITTEN when captured ` +
        '(lastInFlight) — treat that exchange as a draft. ' : '') +
      'A session that simply STOPS looks exactly like one still in progress; lastTs is when it was ' +
      'last captured, not evidence that it finished.'
  }, 'sessions-output');
}

// READ FORWARD FROM A HIT, in the order the conversation actually happened.
//
// `threadLast` hands back the END of a thread, which is the right answer for a
// short one and the wrong end of a long one: the resolution to a claim made at
// exchange 200 of a 650-exchange thread is almost always at 201-210, not at 650.
// Relevance cannot find it either -- the exchange that RESOLVES something often
// shares almost no vocabulary with the exchange that raised it ("done", "shipped",
// "you were right"). Sequence can, and sequence is already in the corpus: the
// names are x-<session>-<ask timestamp>, which sort as time.
//
// So this is arithmetic, not retrieval. No ranking, no scoring, no judgment: given
// an anchor, return its neighbours in order. It is the half of "what happened
// after Y" that neither search nor latest can answer.
export async function thread(name, opts = {}) {
  // `forward`/`back`, NOT `after`/`before`. Those names were already taken by
  // search's DATE filters, and the collision produced a silent empty answer:
  // thread({after:'2026-08-01'}) ran Math.max(0,'2026-08-01') -> NaN, sliced to
  // nothing, and reported "this window covers 616-NaN" with results: []. Found by
  // calling the real MCP tool after a restart; every lib-level test had passed,
  // because they all passed numbers.
  const { scope = 'staging', snippetChars = RETRIEVAL.snippetChars } = opts;
  const count = (v, fallback) => {
    if (v === undefined || v === null || v === '') return { n: fallback };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { bad: String(v) };
    return { n: Math.floor(n) };
  };
  const fwd = count(opts.forward !== undefined ? opts.forward : opts.after, 8);
  const bwd = count(opts.back !== undefined ? opts.back : opts.before, 0);
  if (fwd.bad || bwd.bad) {
    return guardValue({
      anchor: name, mode: 'thread', scope, results: [],
      error: `thread takes COUNTS, not dates: got ${JSON.stringify(fwd.bad || bwd.bad)}. Use ` +
        '`forward` and `back` (numbers of exchanges). `after`/`before` are search\'s DATE filters ' +
        'and mean something different there — that name collision used to return an empty result ' +
        'silently, so it is now refused loudly.'
    }, 'thread-output');
  }
  const after = fwd.n, before = bwd.n;
  const { idx, stamp } = await ensureFresh(scope);
  if (!idx.present) return { anchor: name, mode: 'thread', scope, results: [], note: 'no index for this scope' };

  const t = idx.threads && idx.threads.get(name);
  if (!t) {
    // A wrong scope is the likely cause and is invisible otherwise, so name it.
    const known = idx.docs.some((d) => d.name === name);
    return guardValue({
      anchor: name, mode: 'thread', scope, ...stamp, results: [],
      note: known
        ? `'${name}' is in scope '${scope}' but is not a threaded exchange — only ingested ` +
          'exchanges (x-<session>-<ask timestamp>) have a sequence. Curated memories are standalone files.'
        : `'${name}' is not in scope '${scope}'. Ingested exchanges live in scope:'staging'; ` +
          'check the name came from a staging result.'
    }, 'thread-output');
  }

  const byName = new Map(idx.docs.map((d) => [d.name, d]));
  const i = t.position - 1;
  const from = Math.max(0, i - Math.max(0, before));
  const to = Math.min(t.names.length, i + Math.max(0, after) + 1);
  const window = t.names.slice(from, to);

  const results = window.map((n, k) => {
    const doc = byName.get(n);
    const pos = from + k + 1;
    return {
      name: n,
      isAnchor: n === name,
      threadPosition: `${pos} of ${t.total}`,
      offset: pos - t.position,        // -2 = two BEFORE the anchor, +3 = three after
      ts: doc?.ts || doc?.modified || null,
      sessionTitle: doc?.sessionTitle || null,
      ...(doc && isCompactionSummary(doc) ? { isCompactionSummary: true } : {}),
      snippet: guardValue(trimSnippet(String(bodyOf(doc) || '').slice(0, snippetChars * 2), snippetChars * 2), 'thread-snippet')
    };
  });

  await attachCommits(results, window.map((n) => bodyOf(byName.get(n))));

  // WHAT LANDED WHILE THIS WAS BEING SAID. The corpus records promises ("I'll
  // commit the fix") far more reliably than outcomes -- measured, a session that
  // produced 12 commits named 2 of them in its text, because the work happened in
  // tool calls and ingest captures prose. Reading the corpus harder cannot recover
  // what was never written; joining on TIME can, and needs no SHA and no wording.
  const spanFrom = results[0]?.ts || null;
  const spanTo = results[results.length - 1]?.ts || null;
  let landed = [];
  try {
    landed = await commitsInRange(spanFrom, spanTo);
  } catch { landed = []; }

  const guidance = [
    'THIS IS A SEQUENCE, NOT A RANKING — read it in order. `offset` is relative to the anchor: ' +
    'negative is before it, positive is after.',
    `Anchor ${name} is ${t.position} of ${t.total}; this window covers ${from + 1}-${to} and ` +
    `${t.total - to} exchange(s) after it are not shown` + (to < t.total ? ` (raise \`forward\`, or jump to ${t.last}).` : '.'),
    'THE LAST WORD IS NOT CURRENT TRUTH: this is what was SAID next, not what happened next. ' +
    'A claim that something was committed is confirmed by git, not by the sentence after it.'
  ];
  if (landed.length) {
    guidance.push(`${landed.length} commit(s) landed in the configured repos DURING this stretch ` +
      `of conversation (${String(spanFrom).slice(0, 16)} to ${String(spanTo).slice(0, 16)}) — see ` +
      'commitsDuringWindow. EVIDENCE, NOT PROOF: a commit inside the window may be unrelated work, ' +
      'and related work can land days later. But it answers "was anything actually done here?" ' +
      'without depending on whether the conversation wrote the SHA down — measured, one session ' +
      'produced 12 commits and named 2.');
  }

  logQuery({ query: name, mode: 'thread', scope, totalCandidates: results.length,
    noStrongMatch: !results.length, results });

  return guardValue({
    anchor: name, mode: 'thread', scope, ...stamp,
    ...(landed.length ? { commitsDuringWindow: landed, windowSpan: { from: spanFrom, to: spanTo } } : {}),
    threadTotal: t.total, anchorPosition: t.position, threadLast: t.last,
    windowFrom: from + 1, windowTo: to, remainingAfter: t.total - to,
    guidance, results
  }, 'thread-output');
}
