// lib/config.js — paths and the embedding contract.
//
// The EMBEDDING CONTRACT below is the thing the index header is validated
// against. If ANY of these values changes, every previously-written vector is
// meaningless: the loader must refuse the old index rather than silently
// return garbage neighbours. (Asymmetric models are especially unforgiving —
// embedding a query WITHOUT the prefix, or a passage WITH it, costs recall
// quietly, with no error anywhere.)

import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { localString } from './local-config.js';
import { stateRoot } from './state-root.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// MEMORY_ROOT lets a RELEASED COPY of the code (dist/capture, see scripts/release-capture.sh) keep
// using this repo's data: store/, the indexes, the model cache, local-config.json. Without it a copy at
// another path would silently fork every one of those. Default: this file's own repo.
export const ROOT = stateRoot();   // MEMORY_ROOT, then existing state, then ~/.agentic-recall for a package install (lib/state-root.js)

// Where the memories live. PER-MACHINE, so it does not live here. Set `memoryDir` in local-config.json (or
// MEMORY_DIR in the environment). The fallback is ./memories beside the server, which is
// where the packaged build puts a corpus — a fresh install works with no configuration,
// and no install carries someone else's home directory.
export const DEFAULT_MEMORY_DIR = localString('MEMORY_DIR', 'memoryDir', join(ROOT, 'memories'));

export function memoryDir() {
  return resolve(process.env.MEMORY_DIR || DEFAULT_MEMORY_DIR);
}

// ---- THE SECOND ROOT ------------------------------------------------------
// memoryDir() above is CLAUDE'S directory: written by whatever session happens
// to be running, and subject to whatever consolidates it. This server reading
// that folder is why its corpus could never diverge from Claude's.
//
// ownStoreDir() is this server's OWN store — the append-only half. Auto-ingested
// material (transcript exchanges) lands here, at ARCHIVE tier by default, so it
// is fully searchable but never outranks a curated memory (RETRIEVAL.boost:
// archive 1.0 vs hot 1.25). Frontmatter can still override per file.
//
// The default is INERT: the root is only used if the directory actually exists,
// so installing this change alters nothing until someone creates the store.
export function ownStoreDir() {
  const v = process.env.MEMORY_OWN_STORE;
  if (v === '0' || v === 'false') return null;
  return resolve(v || join(ROOT, 'store'));
}

/**
 * Every corpus root, in precedence order. Primary first — MEMORY.md, the
 * denylist and the hot default all belong to it.
 * A root's `label` namespaces its files (`store/foo.md`) so two roots can hold
 * the same basename without one shadowing the other in the index.
 */
// EVERY project's memory folder, not one hard-coded path.
//
// Claude keeps memories per PROJECT (~/.claude/projects/<project>/memory), and
// which MCP connectors a surface may call is decided per account. So the corpus
// itself is machine-wide and account-agnostic — but a session run from a
// different project writes somewhere this server was not looking, and those
// memories silently do not exist as far as retrieval is concerned.
//
// Discovery removes that failure mode: any project folder that has a memory/
// directory is a curated root. The canonical one stays FIRST and unlabelled, so
// MEMORY.md, the filename denylist and every existing file id are untouched;
// additional projects are namespaced by their folder so two projects can hold
// the same basename.
//
// Today this changes nothing — one project directory exists. It is here so that
// the first memory written from another project is visible immediately rather
// than after someone notices it is missing.
export function discoverProjectMemoryDirs() {
  const root = join(homedir(), '.claude', 'projects');
  const found = [];
  let entries = [];
  try { entries = readdirSync(root); } catch (_) { return found; }
  for (const e of entries.sort()) {
    const dir = join(root, e, 'memory');
    if (existsSync(dir)) found.push({ dir, project: e });
  }
  return found;
}

/**
 * Extra project memory folders, named outright. `:`-separated MEMORY memory dirs
 * (…/<project>/memory), not project dirs — the project name is read from the
 * parent, exactly as discovery reads it.
 *
 * This exists because the routing below cannot be tested or measured otherwise:
 * only ONE memory folder exists on this machine, so the second-project path had
 * no fixture and no probe run. It is NOT suppressed by MEMORY_DIR — naming a
 * folder explicitly is a deliberate act, unlike discovery, which is a sweep.
 */
export function extraProjectMemoryDirs() {
  const v = process.env.MEMORY_EXTRA_PROJECT_DIRS;
  if (!v || v === '0' || v === 'false') return [];
  return v.split(delimiter).filter(Boolean)
    .map((d) => resolve(d))
    .filter((d) => existsSync(d))
    .map((dir) => ({ dir, project: basename(dirname(dir)) }));
}

// A short, stable label for a non-canonical project root.
function projectLabel(project) {
  const tail = project.split('-').filter(Boolean).slice(-3).join('-');
  return (tail || project).slice(0, 40);
}

// ---- WHERE ANOTHER PROJECT'S MEMORIES GO ----------------------------------
// They are CURATED-TYPE content — hand-written rules, project notes and
// feedback, the same register and the same authorship as the canonical folder's.
// Until 2026-08-20 they were routed into STAGING by `primary: false`, which
// ranked them as though they were raw conversation exchanges: archive-tier
// semantics, no hot boost, and unreachable at the default scope. A standing rule
// written from another project would have ranked below transcript chatter.
//
// THEY GET THEIR OWN INDEX, and that was MEASURED the same way the handoff
// corpus was (scripts/bench-probes.js, 16-document fixture second project under
// test/fixtures/projects/, routed into the curated index):
//
//   metric                    curated-only   +15 other-project memories inside
//                                            the curated index
//   MRR (24 ranked probes)       0.8125                 0.7917
//   probes in top-3              22/24                  22/24
//   absence verdict               4/4                    4/4
//   P2 (paraphrase)              rank 1        rank 2, behind a fixture document
//   every other probe's score      —      moved, -2.3% to +6.3%, content unchanged
//
// TWO separate damages, and they are worth telling apart.
//
// SHARED STATISTICS is the one that generalises. Not a single curated document
// changed, and every single probe's top score moved — V2 +5.1%, E9 +4.2%, N2
// -2.3%. Fifteen documents joining a 122-document corpus move BM25's average
// document length and every idf, so queryIdealScore moves, so `absoluteKeyword`
// scales differently, so the fused score of every memory changes. That is the
// same mechanism that cost the handoff experiment an absence verdict (X4, on a
// 0.0042 margin). Here it did not cross a floor. Next month, with a different
// corpus, there is nothing to say it would not.
//
// COMPETITION is the one that is specific and vivid: P2 asks what to run after
// editing the huge single-page web file, and a memory from ANOTHER project took
// rank 1 from this project's standing rule. Not because it was better, because it
// was in the same ranked list. Separate sections dissolve exactly that — the same
// reason scope:'all' returns groups rather than one merged list.
//
// Design (b), shipped: the curated index built with the fixture present is
// bit-for-bit the control — corpusHash 56b48c09…, 122 docs, 1,586 chunks, all
// three unchanged — and the fixture's 15 documents are a 33-chunk index of their
// own. Re-runnable: MEMORY_EXTRA_PROJECT_DIRS=<fixture>/memory with
// MEMORY_PROJECT_CORPUS=curated reproduces the middle column.
//
// So: own index, own statistics, curated numbers bit-for-bit unchanged. What is
// DIFFERENT from the handoff corpus, and deliberate:
//   * HOT default tier. These are curated memories, not institutional history.
//   * WRITABLE. demote/promote work on them; they are real memories that a
//     future session may legitimately want to archive. Only the handoff corpus
//     is read-only.
//   * project + per-file account metadata carried, so both filters work.
//   * REACHED BY DEFAULT. The router widens to 'all' whenever a project corpus
//     exists (tools/memory.js), because a standing rule that needs an explicit
//     scope to be found is a standing rule nobody finds.
//
// MEMORY_PROJECT_CORPUS re-points them ('curated' reproduces the measurement
// above, 'staging' restores the old behaviour). MEMORY_ALL_PROJECTS=0 drops them
// entirely.
export function projectCorpusName() {
  const v = String(process.env.MEMORY_PROJECT_CORPUS || '').trim().toLowerCase();
  return (v === 'curated' || v === 'staging' || v === 'projects') ? v : 'projects';
}

/**
 * Every OTHER project's memory folder as a corpus root. The canonical folder is
 * never among them (it is the primary curated root), and a folder named twice —
 * discovered and also passed explicitly — appears once.
 */
export function projectRoots(account = null) {
  if (process.env.MEMORY_ALL_PROJECTS === '0' || process.env.MEMORY_ALL_PROJECTS === 'false') return [];
  const corpus = projectCorpusName();
  // An explicit MEMORY_DIR means the caller is scoping deliberately (the test
  // suite does this for every mutation fixture), so DISCOVERY stays out of the
  // way. Without this guard a fixture pointing at a temp corpus still inherits
  // the real project folder and the assertions measure the wrong population —
  // which is exactly what happened when discovery was first added. An explicitly
  // named extra folder is not a sweep, so it is honoured either way.
  const discovered = process.env.MEMORY_DIR ? [] : discoverProjectMemoryDirs();
  const seen = new Set([resolve(memoryDir())]);
  const roots = [];
  for (const { dir, project } of [...discovered, ...extraProjectMemoryDirs()]) {
    const r = resolve(dir);
    if (seen.has(r)) continue;
    seen.add(r);
    roots.push({
      dir: r,
      label: projectLabel(project),
      // CURATED-TYPE: hot by default, exactly like the canonical folder. A
      // memory's own frontmatter tier still wins per file.
      defaultTier: 'hot',
      // `primary` stays FALSE: MEMORY.md ownership, the filename denylist's
      // un-namespaced ids and the "loaded first" ordering belong to the
      // canonical folder alone. `corpus` is what routes.
      primary: false,
      corpus,
      account,
      // The folder IS the project, so unlike `account` this is legitimately
      // inherited from the root (see loadCorpus).
      project
    });
  }
  return roots;
}

// ---- WHOSE MEMORY IS THIS -------------------------------------------------
// The point of labelling: work on one account, continue on another, and be able
// to say "only mine" when another account's notes would be noise — while still
// being able to reach across deliberately.
//
// HONEST LIMIT: this server is a stdio process. NOTHING in the MCP protocol
// tells it which Claude account is calling, so it cannot stamp the label by
// itself. The label has to be supplied:
//   * MEMORY_ACCOUNT=<name> in the surface's MCP config stamps everything that
//     surface writes and reads as that account, or
//   * metadata.account in a memory's own frontmatter, which always wins.
// Unlabelled memories carry account: null and are returned by every query, so
// nothing existing disappears the day labelling is switched on.
// The signed-in account, read LIVE from ~/.claude.json. This is what makes
// automatic labelling possible at all: MCP hands the server no identity, and
// this Mac has ONE shared config per surface, so nothing static can distinguish
// two accounts. The oauth record does, because it reflects whoever is signed in
// at the moment the write happens.
// Transcripts were checked first and carry no account field, so this is the only
// local source.
export function signedInAccount() {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    const email = j?.oauthAccount?.emailAddress;
    return (typeof email === 'string' && email.includes('@')) ? email : null;
  } catch (_) { return null; }
}

export function accountLabel() {
  const v = String(process.env.MEMORY_ACCOUNT || '').trim();
  if (v) return v;                       // explicit override always wins
  if (process.env.MEMORY_ACCOUNT_AUTO === '0') return null;
  return signedInAccount();
}

// ---- THE THIRD KIND OF ROOT: INSTITUTIONAL HANDOFF DOCUMENTS --------------
// The handoff documents are where a phase of work is written down for whoever
// picks it up next — the state of a campaign, what shipped, what is still open.
// They lived OUTSIDE both corpora, which meant no query could reach them: a
// session asking "what is the state of the corpus refresh" got the memory
// summary and never the handoff that holds the detail. Daniel approved indexing
// them (2026-08-19).
//
// THEY GET THEIR OWN INDEX, and that was MEASURED, not assumed. Curated
// inclusion was tried first (archive tier, so no hot boost, with
// RETRIEVAL.maxArchiveShare holding half the page). Over the 32 probes the
// handoff documents took ZERO top-3 slots — they crowded nothing out — and the
// benchmark still regressed:
//
//   metric                curated-only   +14 handoff docs in the curated index
//   MRR (24 ranked)          0.8194                 0.7986
//   absence verdict           4/4                    3/4     (X4 lost)
//   P2 paraphrase           rank 1                 rank 2
//
// The cause is not competition, it is SHARED STATISTICS. Several retrieval
// constants are derived from the corpus at load time, and the biggest is
// `referenceChunks` — the p90 of the chunk-count distribution, which the
// long-document correction shrinks against. Fourteen long documents moved it
// from 16 to 19, which quietly RAISED the dense score of every curated memory
// above 16 chunks. That pushed `partner-email-rules` to 0.3842 against an
// absence scoreFloor of 0.38 — a 0.0042 margin — and the server stopped being
// able to say "I have no memory of a Postgres migration".
//
// This is the same lesson as staging (see stagingIndexPath below): a corpus with
// a different length and register cannot share another corpus's lexical
// statistics, however well-behaved its documents are in the ranking. So there
// are THREE indexes, each with its own statistics, and the curated numbers are
// bit-for-bit what they were.
//
// The other three properties:
//   * READ-ONLY. `readOnly: true` travels onto every doc, and doTier() refuses
//     to write to one. These files belong to other work; this server may read
//     them and nothing else. There is no MCP path that writes, demotes or
//     deletes them.
//   * ARCHIVE TIER. Kept even in their own index: within a handoff result page
//     it is neutral, and it means a future decision to blend them starts from
//     the conservative setting.
//   * MATCHED BY NAME. `match` restricts the root to the handoff patterns, so a
//     root directory that also holds unrelated .md files contributes only the
//     handoff documents.
// 2026-08-29: pre-registrations join the handoff corpus. They are the closest thing
// this project has to a written narrative — the bar, the controls, the numbers and the
// wrong turns, recorded BEFORE the outcome was known, so hindsight cannot rewrite them.
// 15 of them existed and NONE was reachable: they match no pattern above and live in
// `test/` dirs that were not roots. Daniel asked for opt-in prose linked to the
// important things; this is that, aimed at durable artifacts rather than transcripts,
// and it costs curated nothing because the handoff corpus is a separate index.
export const HANDOFF_PATTERNS = [/^HANDOFF.*\.md$/i, /^PHASE.*\.md$/i, /-HANDOFF.*\.md$/i,
  /-preregistration\.md$/i];

// EMPTY BY DEFAULT, AND THAT IS THE FEATURE. The handoff corpus indexes documents
// that live OUTSIDE the memory folder, so its roots are a statement about one
// person's disk. Shipping anybody's actual directories as defaults would mean every
// other install carries a list that resolves to nothing — silently, since the
// existsSync filter below drops what is absent. Opt in with MEMORY_HANDOFF_DIRS
// (`:`-separated, or `;` on Windows); leave it unset and there is simply no handoff
// corpus, which costs the rest of the system nothing because it is a separate index.
//
// Two properties worth knowing before you add a root:
//   * THE SCAN IS FLAT, by design — a handoff one level below a listed root is not
//     found. Recursion would ingest handoff copies inside extracted zips and backups.
//     The orphan alarm warns about exactly that near-miss instead.
//   * ROOTS ARE MATCHED BY NAME (see `match` above), so a directory that also holds
//     unrelated .md files contributes only its handoff documents. That is what makes
//     listing something like a `test/` directory safe: it yields the
//     *-preregistration.md files and leaves the fixtures and answer keys beside them.
export const DEFAULT_HANDOFF_DIRS = [];

/** Directories scanned for handoff documents. MEMORY_HANDOFF_DIRS overrides (`:`-separated). */
export function handoffDirs() {
  const v = process.env.MEMORY_HANDOFF_DIRS;
  if (v === '0' || v === 'false') return [];
  const list = v ? v.split(delimiter).filter(Boolean) : DEFAULT_HANDOFF_DIRS;
  return list.map((d) => resolve(d)).filter((d) => existsSync(d));
}

export function handoffRoots(account = null) {
  // MEMORY_HANDOFF_DOCS=0 turns the whole corpus off.
  if (process.env.MEMORY_HANDOFF_DOCS === '0' || process.env.MEMORY_HANDOFF_DOCS === 'false') return [];
  return handoffDirs().map((dir) => ({
    dir,
    label: `handoff-${basename(dir).toLowerCase()}`,
    defaultTier: 'archive',
    // Its OWN index, for the measured reason above. `primary` stays the
    // curated/not-curated flag every existing caller reads; `corpus` is the
    // three-way one.
    primary: false,
    corpus: 'handoff',
    account,
    // project stays NULL deliberately: a handoff document is cross-project, and
    // a null project is never filtered out. Its provenance is its PATH.
    project: null,
    match: HANDOFF_PATTERNS,
    readOnly: true,
    docType: 'handoff-doc'
  }));
}

// ---- THE LIBRARY: CATEGORY-ISOLATED REFERENCE CORPORA ----------------------
// Books, manuals, policies — imported REFERENCE material, which is a different
// thing from a memory. Daniel's rule (2026-08-26): nothing here may dilute or
// even touch vibe-coding retrieval unless a search names it. The server has
// already measured what sharing an index costs, twice (staging: MRR 0.826 ->
// 0.681; handoff: 14 documents moved `referenceChunks` and broke an absence
// verdict on a 0.0042 margin), so the cure is the same as both times — own
// corpus, own index file, own statistics — generalised into user-defined
// CATEGORIES:
//
//   <libraryBaseDir>/<category>/          (see libraryBaseDir below)
//
// Each immediate subdirectory is a corpus (precedent: discoverProjectMemoryDirs
// sweeps project folders the same way). Category `books` -> corpus name `books`
// -> index `.lib-books-index.json`. A new content class is `mkdir` + import —
// zero code, zero risk to any other corpus, because per-corpus statistics are
// isolated BY CONSTRUCTION (bm25/referenceChunks/profile all derive inside
// loadScope from one index file).
//
// REACH ISOLATION is the half a separate index cannot give: `CORPORA` below
// stays THE WORK SET, `scope:'all'` expands to it and nothing else, and
// routeScope never returns a category. A category is searched ONLY when named
// (`scope:'books'`, `scope:['all','books']`) or via `scope:'everything'`.
//
// READ-ONLY, like handoff: import's own fs path is the sole writer; doTier and
// every MCP write refuse. ARCHIVE tier — within its own index that is neutral,
// and a future decision to blend anything starts conservative.
export function libraryBaseDir() {
  // PER-MACHINE, like memoryDir: set `libraryDir` in local-config.json or
  // MEMORY_LIBRARY_DIR. Falls back to ./memory-library beside the server, so a fresh
  // install has a working location and no install carries someone else's home directory.
  return resolve(localString('MEMORY_LIBRARY_DIR', 'libraryDir', join(ROOT, 'memory-library')));
}

// Category names double as corpus names and index-file stems, so they are held
// to a shape that cannot collide with either: word characters and hyphens, and
// never a name the scope grammar already owns.
const LIBRARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LIBRARY_RESERVED = new Set([...['curated', 'projects', 'staging', 'handoff'], 'all', 'everything']);

// Discovery is a readdir per call site, so it carries a small cache — keyed by
// the base dir AND ITS MTIME, never by time alone: creating a category (mkdir,
// by import or by hand) touches the base dir's mtime, so the next call sees it
// immediately. A time-keyed draft of this served "no categories" for two
// seconds after an import had just created one, and the very next index call
// refused a name that provably existed on disk.
let _LIB_CACHE = null;   // { key, names }
export function libraryCorpora() {
  if (process.env.MEMORY_LIBRARY === '0' || process.env.MEMORY_LIBRARY === 'false') return [];
  const base = libraryBaseDir();
  let key;
  try { key = `${base}|${statSync(base).mtimeMs}`; } catch (_) { key = `${base}|absent`; }
  if (_LIB_CACHE && _LIB_CACHE.key === key) return _LIB_CACHE.names;
  const names = [];
  try {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (!LIBRARY_NAME_RE.test(e.name) || LIBRARY_RESERVED.has(e.name)) continue;
      names.push(e.name);
    }
  } catch (_) { /* no library dir = no categories, not an error */ }
  names.sort();
  _LIB_CACHE = { key, names };
  return names;
}

export function libraryRoots(account = null) {
  return libraryCorpora().map((name) => ({
    dir: join(libraryBaseDir(), name),
    label: `lib-${name}`,
    defaultTier: 'archive',
    primary: false,
    corpus: name,
    account,
    // Cross-project reference material; a null project is never filtered out.
    project: null,
    readOnly: true,
    docType: 'library-doc'
  }));
}

/**
 * WHY LIBRARY CATEGORIES CANNOT BE SEARCHED RIGHT NOW — or null when they can.
 *
 * ONE rule, TWO readers, because splitting it is exactly how MEM-32 happened.
 * memoryRoots() below drops the library roots when this returns a reason, so a
 * category is not searched; but `import` did not consult the same rule, so it
 * cheerfully wrote a book into memory-library/ and answered `ok: true` for a
 * document no query could ever reach. A write path and a read path disagreeing
 * about whether a corpus exists is not a config question, it is a lie in a tool
 * response — so the predicate is exported and BOTH sides read it.
 *
 * The MEMORY_DIR clause is the suppression itself: an explicit MEMORY_DIR means
 * "measure THIS corpus and nothing else" (same reason project and handoff
 * discovery are suppressed), and naming MEMORY_LIBRARY_DIR outright is the
 * deliberate act that opts back in. The generated setup snippet sets MEMORY_DIR,
 * which is how a fresh install walked into this: packaging/setup-page.mjs now
 * names both.
 */
export function librarySuppressedReason() {
  if (process.env.MEMORY_LIBRARY === '0' || process.env.MEMORY_LIBRARY === 'false') {
    return 'MEMORY_LIBRARY is switched off';
  }
  if (process.env.MEMORY_DIR && !process.env.MEMORY_LIBRARY_DIR) {
    return 'MEMORY_DIR is set and MEMORY_LIBRARY_DIR is not, so library categories are not searched';
  }
  return null;
}

/**
 * 🟥 MEM-68/U-4 — THE ONE CONFIG STATE THAT IS A MISTAKE RATHER THAN A CHOICE.
 *
 * librarySuppressedReason() above answers "is the library searched?", and two of its answers
 * are deliberate: MEMORY_LIBRARY=0 is a switch someone threw. This one is not. An install
 * upgraded in place from 1.7.0 keeps the config THAT version's setup page generated —
 * MEMORY_DIR without MEMORY_LIBRARY_DIR — which is precisely the MEM-32 trap the 1.7.1 setup
 * page exists to close, and nothing in the upgrade path re-runs setup or says a word. Measured
 * on two installs on one Mac (campaign D.4): the upgraded one's claude-config-snippet.json has
 * MEMORY_DIR only, the fresh one's has both. A `scope:'everything'` search on such an install
 * omits every library category in silence.
 *
 * So the state gets a NAME, a boot line (index.js) and a `configWarning` stamped onto responses
 * (lib/search.js) — the same treatment captureHealth gets, for the same reason: a corpus that is
 * not being searched must say so where the answer is read, not only where the config is written.
 * Null when there is nothing wrong, so an ordinary install pays nothing.
 */
export function configWarning() {
  // A switch someone threw is not a warning.
  if (process.env.MEMORY_LIBRARY === '0' || process.env.MEMORY_LIBRARY === 'false') return null;
  if (process.env.MEMORY_DIR && !process.env.MEMORY_LIBRARY_DIR) {
    return {
      variable: 'MEMORY_LIBRARY_DIR',
      why: 'MEMORY_DIR is set and MEMORY_LIBRARY_DIR is not',
      effect: 'library categories (imported books, manuals and documents) are NOT searched — not at ' +
        "scope:'everything' either — and `import` into a category refuses",
      fix: 'add MEMORY_LIBRARY_DIR to the memory server block of your Claude config and restart Claude. ' +
        'Re-running SETUP regenerates the whole snippet with both variables (an install upgraded from ' +
        '1.7.0 keeps the old one-variable config).'
    };
  }
  return null;
}

/** Work corpora + every library category — what scope:'everything' means. */
export function allCorpora() {
  return [...CORPORA, ...libraryCorpora()];
}

/** Is this corpus name a library category (as opposed to a work corpus)? */
export function isLibraryCorpus(name) {
  return !CORPORA.includes(name) && libraryCorpora().includes(name);
}

/** Would this string be accepted as a NEW category name? */
export function isValidCategoryName(name) {
  return typeof name === 'string' && LIBRARY_NAME_RE.test(name) && !LIBRARY_RESERVED.has(name);
}

// Optional per-category configuration: memory-library/<name>/.category.json
// ({domain, description, note}). `domain` feeds the advice layer, because
// counting cannot tell a novel from a statute — both are prose — and the right
// retry advice differs. Absent or unreadable, the derived corpus profile
// decides, exactly as before.
export function categoryConfig(name) {
  try {
    const j = JSON.parse(readFileSync(join(libraryBaseDir(), name, '.category.json'), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

export function memoryRoots() {
  const canonical = memoryDir();
  const acct = accountLabel();
  // PROJECT is a property of WHERE a memory lives, so unlike `account` it is
  // legitimately inherited from the root: the folder IS the project. Claude
  // stores memories per project, and this makes that dimension searchable.
  const canonProject = basename(dirname(canonical));
  const roots = [{ dir: canonical, label: null, defaultTier: 'hot', primary: true, corpus: 'curated', account: acct, project: canonProject }];

  // Other projects' memories: curated-type content in their OWN corpus, hot
  // tier, namespaced by project. See projectRoots() for the measurement that put
  // them in their own index rather than in the curated one — and for what they
  // used to do instead, which was to be ranked as staging.
  roots.push(...projectRoots(acct));

  // Handoff documents. Suppressed by an explicit MEMORY_DIR for the same reason
  // project discovery is: a fixture pointing at a temp corpus must measure that
  // corpus and nothing else, or the assertions count the wrong population.
  if (!process.env.MEMORY_DIR) roots.push(...handoffRoots(acct));

  // Library categories. Same MEMORY_DIR suppression — except when the caller
  // names a library dir OUTRIGHT, which is a deliberate act, not a sweep (the
  // extraProjectMemoryDirs precedent): the suite points MEMORY_DIR at a temp
  // corpus AND MEMORY_LIBRARY_DIR at a temp library in the same fixture.
  // The rule itself lives in librarySuppressedReason() so `import` cannot
  // disagree with this line about whether the corpus is reachable (MEM-32).
  if (!librarySuppressedReason()) roots.push(...libraryRoots(acct));

  const own = ownStoreDir();
  if (own && existsSync(own)) roots.push({ dir: own, label: 'store', defaultTier: 'archive', primary: false, corpus: 'staging', account: acct, project: 'store' });
  return roots;
}

/**
 * Every corpus name that has its own index.
 *
 * ORDER IS THE RESULT ORDER for scope:'all' (lib/search.js flattens the groups in
 * this order for the back-compat `.results` array), so the two curated-type
 * corpora come first.
 */
export const CORPORA = ['curated', 'projects', 'staging', 'handoff'];

/** The roots belonging to one corpus. `primary` remains the curated flag. */
export function rootsForCorpus(name, roots = memoryRoots()) {
  return roots.filter((r) => (r.corpus || (r.primary ? 'curated' : 'staging')) === name);
}

/** Where one corpus's index lives. Returns null when that corpus is switched off. */
export function indexPathForCorpus(name) {
  if (name === 'staging') return stagingIndexPath();
  if (name === 'handoff') return handoffIndexPath();
  if (name === 'projects') return projectsIndexPath();
  // Any name that is not a work corpus resolves as a LIBRARY index path —
  // including a category whose directory has vanished. Falling back to the
  // curated index here would answer a scope:'books' query from curated while
  // labelling it 'books', which is the exact silent-mislabel bug latestAll had.
  // A path to an index that does not exist loads as present:false — an honest
  // empty answer.
  if (name && name !== 'curated' && !CORPORA.includes(name)) return libraryIndexPath(name);
  return indexPath();
}

// Library index files live beside the other four in the repo root by default;
// MEMORY_LIBRARY_INDEX_DIR redirects the whole family (the MEMORY_INDEX trap:
// redirecting one index and not its siblings polluted a live index once).
export function libraryIndexPath(category) {
  if (process.env.MEMORY_LIBRARY === '0' || process.env.MEMORY_LIBRARY === 'false') return null;
  const dir = process.env.MEMORY_LIBRARY_INDEX_DIR ? resolve(process.env.MEMORY_LIBRARY_INDEX_DIR) : ROOT;
  return join(dir, `.lib-${category}-index.json`);
}

export function indexPath() {
  return resolve(process.env.MEMORY_INDEX || join(ROOT, '.memory-index.json'));
}

// Where retrieval telemetry lands. One JSON line per search, appended.
// Set MEMORY_QUERY_LOG=0 to turn it off; any other value is used as the path.
// NOTE: what is written is the GUARDED payload (post lib/secrets.js), never the
// raw query — otherwise this log would be the one place a credential typed into
// a search could survive every other scrub.
export function queryLogPath() {
  const v = process.env.MEMORY_QUERY_LOG;
  if (v === "0" || v === "false") return null;
  return resolve(v || join(ROOT, ".query-log.jsonl"));
}

// ---- TWO INDEXES, AND WHY THEY CANNOT BE ONE -----------------------------
// MEASURED 2026-08-17. Putting 499 auto-ingested exchanges in the SAME index as
// 114 curated memories cost three probes their answer (found 22 -> 19) and MRR
// 0.826 -> 0.681 — and excluding archive from the RESULTS did not fix it
// (0.729), because BM25's document frequencies and queryIdealScore are computed
// over the whole index before any filter runs. Out-of-domain raw top-1 rose
// 5.73 -> 7.82 against an absFloor of 8.0: the margin that makes that constant
// mean anything went from 2.27 to 0.19.
//
// So the corpora get separate indexes and separate lexical statistics. This is
// the shape a large sibling app already proves: 102k email vectors live in
// their own sidecar beside emails.db, never inside it.
//
// The boundary is the CURATION boundary. Staging holds what dream mode has not
// adjudicated; promoting a document moves it into the curated corpus, and it is
// re-indexed there. Nothing auto-ingested can move a curated constant.
export function stagingIndexPath() {
  const v = process.env.MEMORY_STAGING_INDEX;
  if (v === '0' || v === 'false') return null;
  return resolve(v || join(ROOT, '.staging-index.json'));
}

// The THIRD index: institutional handoff documents (see handoffRoots above for
// the measurement that put them here rather than in the curated index).
export function handoffIndexPath() {
  const v = process.env.MEMORY_HANDOFF_INDEX;
  if (v === '0' || v === 'false') return null;
  return resolve(v || join(ROOT, '.handoff-index.json'));
}

// The FOURTH index: other projects' memory folders (see projectRoots above).
// Curated-type content, hot tier, writable — but its own statistics, for the
// same measured reason the other two are separate.
export function projectsIndexPath() {
  const v = process.env.MEMORY_PROJECTS_INDEX;
  if (v === '0' || v === 'false') return null;
  return resolve(v || join(ROOT, '.projects-index.json'));
}

// ---- PROBES (Phase 3a — dark) ----------------------------------------------
// Where the nightly sweep writes its verdicts. A SIDECAR, never the memory
// files: the sweep must not be able to rewrite a memory under any failure.
// Same privacy class as the indexes (mirrors claim text) — gitignored.
// Where the protected-set margin monitor appends its history. A SIDECAR like
// the probe results, gitignored, one JSON line per run. The d1 lesson: a
// 0.005 margin was invisible until a fixture walked into it, so margins get
// watched over time rather than discovered in a red suite.
export function marginHistoryPath() {
  const v = process.env.MEMORY_MARGIN_HISTORY;
  if (v === '0' || v === 'false') return null;
  return resolve(v || join(ROOT, '.margin-history.jsonl'));
}

export function probeResultsPath() {
  const v = process.env.MEMORY_PROBE_RESULTS;
  if (v === '0' || v === 'false') return null;
  return resolve(v || join(ROOT, '.probe-results.json'));
}

// The checking-level dial. `cheap` = local file/git/date predicates; `all`
// (default since 2026-08-28) adds port/http/sqlite/cmd; `off` runs nothing
// (every probe UNKNOWN, reason 'probe level off' — never STALE).
//
// DANIEL'S CALL, on the measurement: `cheap` swept the live set in 261 ms and
// left 2 of 10 verdicts permanently UNKNOWN; `all` swept in 3.36 s and turned
// both into real FRESH verdicts. Three seconds, once a night, unattended, is
// not a cost — an UNKNOWN that can never resolve is. A CLOSED local port fails
// fast (28 ms, ECONNREFUSED), so a stopped app costs nothing either; the only
// pathological case is a black-holed remote host (5 s timeout each), and the
// probe adjudication deliberately rejected every off-site target
// (test/probe-proposal-adjudications.md), so the live set has none.
//
// 🟥 This also GRANTS `sqlite_query_ro` and `cmd_output_matches`, which no probe
// uses today — a capability decision, not only a cost one. Both stay bounded by
// the same closed vocabulary, execFile-only, allowlisted-binary, metacharacter-
// rejecting, timeout-capped evaluator; sqlite is opened `mode=ro` in code.
// `MEMORY_PROBE_LEVEL=cheap` reverts to the old behaviour without a deploy.
export function probeLevel() {
  const v = String(process.env.MEMORY_PROBE_LEVEL || 'all').toLowerCase();
  return ['off', 'cheap', 'all'].includes(v) ? v : 'all';
}

export function modelCacheDir() {
  return resolve(process.env.MEMORY_MODEL_CACHE || join(ROOT, '.model-cache'));
}

export function secretsConfigPath() {
  // OVERRIDABLE so a self-test can supply its own denylist. scripts/verify-stdio.js used to
  // name a fixture after an entry in the SHIPPED excludeFiles, which coupled a supposedly
  // self-contained check to one machine's config — and the moment that config stopped shipping
  // with personal entries in it, the public tree's own smoke test failed on a fresh clone.
  // A test that depends on the author's configuration is not a test of the software.
  const override = process.env.MEMORY_SECRETS_CONFIG;
  if (override) return resolve(override);
  return resolve(join(ROOT, 'secrets-exclude.json'));
}

// ---- THE EMBEDDING CONTRACT (index header must match, field for field) ----
export const EMBEDDING = {
  model: 'Xenova/bge-small-en-v1.5',
  // bge-* is ASYMMETRIC: the prefix goes on QUERIES ONLY. Passages stay bare.
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  pooling: 'mean',
  normalize: true,
  dim: 384,
  chunkWords: 200,
  chunkOverlapWords: 40
};

// 2 = vectors are base64-encoded float32 on disk (1 = plain JSON number arrays). The READER
// accepts both, so this bump costs no re-embedding; it exists so OLD code refuses a NEW index
// by name instead of finding no vectors and silently serving BM25-only. That failure was
// observed for real on 2026-09-01 — see test/vector-representation-preregistration.md.
export const INDEX_FORMAT_VERSION = 2;

// ---- THE STALENESS GUARD --------------------------------------------------
// INCIDENT 2026-08-19. The index was last built at 06:18. The corpus files
// changed at 07:13 and again at 20:46. Every search all day served the 06:18
// snapshot and said nothing about it — and a session in another chat read the
// per-record `modified` field (which is the mtime AT INDEX TIME) as if it were a
// live stat, and concluded the wrong thing about the state of the project.
//
// Two separate defects, and this fixes both: the search path now checks the
// corpus mtimes against the index BEFORE answering, and every response says
// when the index was built.
//
// The check is a stat pass, and it is cheap enough to do on every query:
// MEASURED on this Mac, 122 curated files = 1.00 ms cold / 0.69 ms warm; the
// 2,104-file staging store = 11.5 ms cold / 8.7 ms warm. The TTL cache below
// exists so a burst of queries pays it once, not so the check is affordable.
export const FRESHNESS = {
  // How long a stat pass may be reused. Short: the point is to notice an edit.
  statCacheMs: Number(process.env.MEMORY_FRESHNESS_TTL_MS ?? 3000),
  // An inline reindex is only ever the INCREMENTAL path (lib/index-store.js
  // reuses vectors by mtime+hash, and the vector cache is keyed by chunk TEXT,
  // so one edited memory re-embeds only the paragraphs that actually changed).
  // Past this many changed files it stops being incremental in any meaningful
  // sense, and the guard declines to block a search on it — it stamps the
  // response stale instead.
  //
  // 8 is a MEASURED budget, not a round number. Editing one existing memory
  // rebuilds inline in ~1-2 s: its unchanged chunk texts are cache hits and
  // only the edited paragraphs are embedded. Brand-new documents are the
  // expensive case, because nothing about them is cached — the first build that
  // took in the 14 handoff documents embedded 755 new chunks and took 70.7 s
  // for 15 changed files, i.e. ~4.7 s/file. At 8 the worst case is ~40 s, which
  // a client will wait through; at 25 it is two minutes, which it will not.
  maxInlineFiles: Number(process.env.MEMORY_INLINE_REINDEX_MAX ?? 8),
  // The FIRST build of a corpus that has no index at all — the day-2 case, when
  // another project has just written its first memories. Nothing is cached, so
  // the whole corpus is embedded; at the ~4.7 s/file measured above, 40 files is
  // a worst case a client waits through and a bound a query cannot exceed. Past
  // it the search is answered honestly (`indexStale`, plus the sentence saying
  // what to run) rather than blocked for minutes. The curated corpus (122 files)
  // and the staging store (2,100) are both far over this, so their behaviour is
  // unchanged.
  firstBuildMaxFiles: Number(process.env.MEMORY_FIRST_BUILD_MAX ?? 40),
  // 🟥 A CORRUPT INDEX IS NOT A FIRST BUILD (MEM-59 / campaign C, C-9), and the bound above was
  // applied to both because an unparseable file reads as `!present`. MEASURED on both sides: a
  // 16-file curated corpus with a 60 %-truncated index repairs inline in 0.40 s and answers 5 rows;
  // a 56-file one is refused, `auto-ingest` never touches curated at all (its own header says it
  // owns the STAGING store and index), so nothing automatic ever repairs it — 0 rows at 120 s, and
  // every message calls the corrupt file a missing one. Daniel's real curated corpus is far over 40.
  //
  // WHY A BACKGROUND REBUILD RATHER THAN LIFTING THE BOUND. The obvious fix is "a corpus that HAD an
  // index has a warm vector cache, so let it rebuild inline". Measured on this machine, in a warm
  // process with a warm cache, over the author's real curated corpus (190 files → 420 documents):
  // 3.21 s and 2.88 s. That is already over a 2 s budget for a blocked query, the staging store is
  // 7x larger, and a cache that is NOT warm makes it 90-110 s at the campaign's measured
  // 0.21-0.26 s/document. So the query is answered honestly IMMEDIATELY and the rebuild runs off
  // the request (lib/freshness.js repairCorruptIndex), the same shape as the async `index` job.
  // The inline path still owns everything under firstBuildMaxFiles, so the 16-file case is
  // unchanged. Kill switch: MEMORY_CORRUPT_INDEX_REPAIR=0 (then a corrupt index is reported, and
  // repaired only by a human running `memory({action:"index"})`, which is today's behaviour).
  corruptRepairEnabled: process.env.MEMORY_CORRUPT_INDEX_REPAIR !== '0' && process.env.MEMORY_CORRUPT_INDEX_REPAIR !== 'false',
  // After a failed inline rebuild, stop retrying for this long. Without it a
  // broken model load turns every single query into a fresh failed build.
  failureCooldownMs: Number(process.env.MEMORY_INLINE_REINDEX_COOLDOWN_MS ?? 60000),
  // Kill switch. MEMORY_INLINE_REINDEX=0 keeps the check and the stamp (the
  // honest part) and drops only the inline rebuild.
  inlineEnabled: process.env.MEMORY_INLINE_REINDEX !== '0' && process.env.MEMORY_INLINE_REINDEX !== 'false'
};

// Retrieval knobs
export const RETRIEVAL = {
  bm25: { k1: 1.2, b: 0.75 },
  // v1.1: `body` is new, and the three groups are now normalised SEPARATELY
  // (see buildBm25). The keyword leg could not see body text at all before, so
  // a quoted sentence had to be recovered by the dense leg, which is the wrong
  // tool for a literal string — benchmark V1 and V6 were lost exactly there.
  //
  // body 0.3 is a MEASURED knee, not a taste. Sweeping it against the 32-probe
  // set and, as a control, the 112 title-literal lookups the keyword scale was
  // originally calibrated to protect:
  //
  //   body   probes in top-3   title-literal @1   npm-test recall
  //   0.0        17/24            107/112             9/10
  //   0.15       21/24            109/112            10/10
  //   0.3        22/24            104/112            10/10     ← shipped
  //   0.45       22/24            100/112             9/10
  //
  // The trade is explicit: five title-literal lookups slip off rank 1 to buy
  // benchmark probe P3 and to keep the paraphrase category whole. Past 0.3 the
  // body starts drowning the summary fields and both controls fall together.
  // keyFacts (Phase 4b) sits between description and name: a hand-written
  // fact ABOUT a section is stronger evidence than its prose and weaker than
  // its title. Weightless in practice unless MEMORY_KEY_FACTS put facts on the
  // document at all.
  fieldWeights: { name: 3.0, description: 2.0, headings: 1.5, body: 0.3, keyFacts: 2.5 },
  // Three legs now. `phrase` is the proximity/quote leg (lib/lexical.js): did
  // the query's words occur TOGETHER anywhere in the body. Small weight because
  // it is near-zero for every non-quote query — a tie-breaker that only fires
  // when it is right, so it buys verbatim recall without moving any other
  // category. MEASURED over the probe set: at weight 0 the verbatim category is
  // 5/6 found and 5/6 at rank 1 (V6 is lost); from 0.12 to 0.28 it is 6/6 found
  // AND 6/6 at rank 1, with every other category identical across that whole
  // plateau. 0.16 is the middle of it.
  //
  // phraseFloor is the leg's DEADBAND, and it is what makes the sentence above
  // ("only fires when it is right") true rather than aspirational. Below the
  // floor a phrase score is not a quote, it is the incidental co-occurrence any
  // two documents on the same subject produce. Measured: probe E9's correct
  // answer and a sibling sit within 0.9% of each other, and raw phrase scores of
  // 0.13 vs 0.08 — both noise — flipped it, costing a rank-1 that v1.0 had. The
  // genuine quotes in the verbatim category all score 0.56 or higher, so any
  // floor from 0.20 to 0.55 removes the regression and keeps all six; 0.35 is
  // the middle of that range. The leg then rescales (phrase-floor)/(1-floor) so
  // it enters continuously rather than as a step.
  fuse: { keyword: 0.42, semantic: 0.42, phrase: 0.16, phraseFloor: 0.35 },
  // How many fused candidates get the phrase rerank + windowed snippet. The
  // phrase leg needs a document's positional token array, which is built on
  // demand and cached; capping the set keeps a query from paying to tokenise
  // 2.7 MB when it is only going to return 3 documents.
  rerankSet: 30,
  snippetChars: 320,
  // bge cosines on this corpus live in a narrow 0.41-0.75 band, so raw values
  // fuse badly with BM25 (everything looks like a 0.9 match). Rescale the band
  // to 0..1 before fusing; below the floor the passage is simply unrelated.
  semanticScale: { floor: 0.40, span: 0.30 },
  // ABSOLUTE scale for the keyword leg. It replaces a per-query-max
  // normalisation, under which the best-scoring document ALWAYS came out at
  // kw = 1.0 — even on a paraphrase where nothing really matched — and then
  // carried half the fused score. (A question about which zip packages to
  // maintain returned an unrelated note about a download
  // link at #1, on the token "download" alone.) A keyword score has to mean the same thing on every
  // query, so it is measured against fixed reference points instead:
  //
  //   floorPoint = min(absFloor, covFloor * ideal)
  //   fullPoint  = min(absFull,  covFull  * ideal)
  //   kw = clamp01((raw - floorPoint) / (fullPoint - floorPoint))   magnitude
  //      * clamp01((raw / ideal) / covFloor)                        share answered
  //
  // where `ideal` = queryIdealScore(): the score a document would earn by
  // matching every query term that exists in the corpus, at full tf.
  //
  // Each reference point is the LESSER of an absolute raw score and a share of
  // what this query can possibly achieve. The absolute half is what stops a
  // paraphrase from crowning an accidental match; the share half is what stops
  // a short exact query ("MEMORY", ideal 7.60) from being punished for having
  // little to match — measured: an absolute-only floor of 8 dropped exact-title
  // lookups from 107/110 to 105/110 at rank 1, with `MEMORY` falling to 14.
  //
  // RE-MEASURED 2026-08-14 after v1.1 put the body into the keyword leg — the
  // raw-score distribution moves when the field set moves, so the constants had
  // to be re-derived rather than inherited (scripts/measure-keyword-scale.js):
  //   A  112 title-literal queries   raw top-1: min 2.57  p10 6.63  med 11.59
  //   A2 112 description-literal     raw top-1: min 9.29  p10 14.66 med 29.98
  //   B   20 in-domain paraphrases   raw top-1: med 7.12  p90 9.11  max 12.41
  //   C   12 out-of-domain queries   raw top-1: med 3.25            max  5.70
  //   coverage (raw/ideal) top-1: A min 0.807 p10 0.867 · A2 min 0.573 p10 0.701
  //                               B max 0.555 · C med 0.354
  //
  // absFloor 8   = still the noise ceiling in raw space: 92% of genuine literal
  //                matches clear it, only 22% of the 32 noise queries do, and
  //                raising it to 10 or 12 was tried and cost benchmark probes E6
  //                and P3 for no gain elsewhere.
  // absFull 20   = the clean split in raw space; no noise query reaches 14.
  // covFloor .60 = RAISED from .55. Coverage is now the sharper separator of the
  //                two: genuine matches bottom out at 0.573 (A2) / 0.807 (A)
  //                while paraphrase noise tops out at 0.555. Measured effect of
  //                the change on its own: title-literal rank-1 106 → 108 of 112
  //                at body 0.15, with nothing else moving.
  // covFull  .85 = where a genuine match's coverage sits (A med 0.896, A2 med
  //                0.763) — the point a short query counts as fully answered.
  //
  // Applies to the FUSED path only. In bm25-only mode there is nothing to fuse
  // against, so the keyword magnitude carries no meaning and the old
  // per-query-max normalisation is kept — degraded-mode ranking is unchanged.
  keywordScale: { absFloor: 8.0, absFull: 20.0, covFloor: 0.60, covFull: 0.85 },
  // ---- LONG-DOCUMENT NORMALISATION (the changelog fix) ---------------------
  //
  // The keyword leg length-normalises itself. The DENSE leg does not, and that
  // is where the 616 KB `project-changelog` was actually winning: doc
  // score = max over chunks, and it has 517 chunks to this corpus's median of
  // 4. 517 draws from the same distribution produce a higher maximum than 4
  // draws do, whatever the document is about — which is why it took a top-3
  // slot on 21 of the benchmark's 32 probes with `provenance: semantic` and a
  // keyword score of exactly 0 on most of them.
  //
  //   factor = (referenceChunks / nChunks) ** alpha        for nChunks > ref
  //
  // …applied to the semantic score only, and WAIVED in proportion to keyword
  // evidence: at kw >= keywordWaiver the document has concentrated lexical hits,
  // has already passed BM25's own length test, and keeps its full dense score.
  // That waiver is what keeps this a de-prioritisation rather than a ban —
  // "sibling app changelog" returns the changelog at rank 1, kw 1.0.
  //
  // referenceChunks is DERIVED per corpus at load time (p90 of the chunk-count
  // distribution: min 1, med 4, p90 16, max 517), so documents up to the 90th
  // percentile pay nothing at all. Using the median instead was tried and
  // rejected — it charged `chat-watcher-speedup` (23 chunks, a legitimately
  // long memory) a third of its dense score and cost benchmark probe P1.
  //
  // MEASURED 2026-08-14 (scripts/measure-longdoc.js, re-runnable):
  //
  //   alpha   probes in top-3   enum items   changelog in top-3
  //   0            22/24          35/41            23/32
  //   0.15         22/24          34/41             0/32
  //   0.35         22/24          34/41             0/32      ← shipped
  //   0.5          22/24          34/41             0/32
  //
  // The effect is a cliff, not a slope, and the plateau from 0.15 to 0.7 is
  // flat on every other measure — which is what a real effect looks like rather
  // than a fitted one. 0.35 sits in its middle. Note also that alpha 0 shows
  // body-BM25 alone does NOT fix the changelog (23/32, slightly worse than
  // v1.0's 21/32): this correction is the fix, and the two are independent.
  longDoc: { alpha: 0.35, keywordWaiver: 0.45 },
  // ---- ARCHIVE MAY NOT CROWD OUT THE CURATED CORPUS ------------------------
  //
  // MEASURED 2026-08-17. Adding 499 auto-ingested transcript exchanges to 114
  // curated memories cost THREE probes their answer entirely (found 22 -> 19)
  // and MRR 0.826 -> 0.681. The diagnosis is not dilution and not a drifted
  // constant — both were tested and neither explains it. The curated documents
  // score EXACTLY what they scored before (P2's target: 0.3528 in both runs).
  // They are simply out-competed: a transcript of the user discussing index.html
  // scores 0.42 against a conversational query where the distilled rule scores
  // 0.35, because the exchange is written in the same register as the question.
  //
  // Raw exchanges are therefore not noise — they are STRONG competitors, and the
  // tier boost (1.0 vs 1.25) cannot close that gap. But a memory that can no
  // longer be found is a broken corpus whatever outranked it, so the populations
  // get separate shelf space rather than one ranked list: archive may take at
  // most this share of the returned slots, and the remainder is held for hot.
  // The archive results are still returned, still ranked, still first if they
  // deserve it — they just cannot take the whole page.
  maxArchiveShare: 0.5,

  // A single document may occupy at most this many of the top-N slots.
  // Doc-level results make this a no-op today; it is enforced (and tested) so
  // that it stays true if chunk-level results are ever emitted.
  maxSlotsPerDoc: 1,

  // ---- ABSENCE VERDICT ------------------------------------------------------
  //
  // "I have no memory of that" has to be an answer the server can give. The
  // benchmark's four absent probes all got a confident-looking document back;
  // one of them (Postgres migration) scored 0.7518, higher than 20 of the 28
  // correct answers.
  //
  // THERE IS NO CLEAN SCORE THRESHOLD, and the numbers say so plainly: the
  // absent probes scored 0.19 / 0.42 / 0.53 / 0.75 while genuinely-correct
  // answers scored as low as 0.43 (E7) and 0.48 (P2). The distributions
  // overlap across their whole middle. So the verdict is not a score cut; it is
  // a conjunction of three independent weaknesses, each measured:
  //
  //   1. score       < scoreFloor        — nothing scored well, AND
  //   2. phrase      < phraseFloor       — the query's words never occur
  //                                        together anywhere, AND
  //   3. strictCoverage < coverageFloor  — raw BM25 / idealFull, i.e. how much
  //                                        of the question was answered ONCE
  //                                        the words that exist nowhere in the
  //                                        corpus are charged for (see
  //                                        queryTermStats). This is the leg
  //                                        that catches "Postgres" and
  //                                        "Kubernetes": drop the word that
  //                                        made the question specific and the
  //                                        remainder matches something well.
  //
  // Every real probe fails at least one of the three; every absent probe fails
  // all three. Constants derived in scripts/measure-absence.js, which prints
  // the full 32-probe distribution and the margin at the chosen point.
  // 🟥 DO NOT NUDGE THESE TO FIX THE PRICE-BOOK RECALL ENTRY. Measured 2026-08-25.
//
// `how is end-of-life marked in the price book` is withheld at topScore 0.3702
// against scoreFloor 0.38, and the right memory sits at rank 1 in bestWeak. It
// looks like a one-hundredth miscalibration. It is not fixable here:
//
//   case                          score   phrase   cov      orphan
//   ABSENT  competitor trade-in   0.3613  0.04     0.1677   0
//   PRESENT price-book EOL        0.3702  0.16     0.1811   0
//
// The nearest must-refuse and must-return cases are 0.009 apart on score and
// 0.013 on coverage. scoreFloor 0.365 or coverageFloor 0.175 does separate them
// TODAY -- and that is fitting two points, not calibrating. Direct evidence the
// fit would not hold: this same entry flipped from fail to pass and back during
// one session purely from two memory files being added to the corpus, so the
// margin is inside ordinary drift.
//
// phraseFloor cannot move either: the Kubernetes (0.25) and Postgres (0.2963)
// refusals both route through byVocabulary and need it above ~0.30.
//
// Semantics DO mostly discriminate -- but not reliably, and that is why no
// absence route reads a semantic score directly. Measured over 12 queries:
// absent 0.358-0.644, present 0.710-1.000, cleanly separated. Then the case
// that matters: absent "Kubernetes" scores 0.7719, which lands INSIDE the
// present range and above the present price-book case at 0.7103. So a floor
// would hold for most queries and fail unpredictably for some -- an embedding
// always has a nearest neighbour and always reports a respectable similarity
// to it. Every signal both routes read is lexical or fused, deliberately.
//
// The actual cause is a synonym gap -- the query says "end-of-life", the memory
// says "EOL" -- so the honest fixes are a real synonym/acronym layer (derived,
// never hand-written; the vocabulary trap has failed three times in this repo)
// or nothing. Adding "end-of-life" to that memory would fix the number and
// contaminate the benchmark, which is separately documented in test/run-tests.js.
absence: { scoreFloor: 0.38, phraseFloor: 0.40, coverageFloor: 0.20, orphanFloor: 0.40, weakResults: 3 },

  // Two-tier mechanics: archive keeps full searchability, it just loses the boost.
  boost: { archive: 1.0, hot: 1.15, hotIndexed: 1.25 },
  // Mild recency decay — a 2-year-old memory keeps ~85% of its score.
  recency: { floor: 0.85, halfLifeDays: 180 },
  defaultLimit: 8
};

// ---- WHERE A QUERY CAME FROM, AND WHY `live` MUST BE EARNED ----------------
//
// The log defaulted to `src: 'live'`, so anything calling lib/search.js directly
// was indistinguishable from a person asking a question. Measured 2026-08-25:
// 7,953 rows tagged `live` in one day across just 99 DISTINCT queries -- the gold
// set, run ~150x each by ~15 suite runs. Six were real.
//
// That is not merely noisy telemetry. dream's `write-description` queue is ORDERED
// BY RETRIEVAL COUNT, so it was prioritising whatever the benchmark hits most:
// "MEMORY retrieved 1875x", and an exchange from the session that was running the
// tests at "600x". The queue meant to say what Daniel needs described was ranked
// by what the test harness happened to ask.
//
// So `live` is now a CLAIM THAT MUST BE EARNED: only a real MCP tool invocation
// sets it (tools/memory.js, inside the server.tool callback, which is reached from
// index.js and nowhere else). Everything else logs `unknown` -- honest about not
// knowing, rather than confidently wrong. An explicit MEMORY_QUERY_SOURCE still
// wins, which is how verify-stdio marks its own synthetic traffic.
let _mcpRequest = false;
export function markMcpRequest() { _mcpRequest = true; }

// ---- WHO IS ASKING, PER REQUEST (MEM-28, 2026-09-05) ------------------------
//
// `live` used to be a one-way, process-wide latch: once any MCP call had been served, every later
// query in the process logged `live` — including a test suite that imported the handler and called
// it directly. Measured over 2026-09-03..05: 288 of 306 "live" rows were the suite's own. And even a
// genuine row said nothing about WHO asked — no client, no request id, no process — so nothing could
// tell a stress session driving the real server from a person.
//
// The context below lives for ONE request: the tool handler begins it with what it knows (the MCP
// client's name/version from the handshake, the JSON-RPC request id, this process's pid@startedAt, the
// scope and limit the caller actually asked for, and one query id shared by every row the request
// writes), and ends it in `finally`. logQuery stamps whatever is present. Between requests the
// context is null and `live` is not claimed. `markMcpRequest()` stays as the latch it always was so
// existing callers and the (a46) pins keep their meaning; `beginMcpRequest` calls it.
//
// No session UUID is reachable over stdio (verified against MCP SDK 1.30.0 — `extra.sessionId` is
// HTTP-only), so `procId` is the session key: Claude spawns one server process per session.
let _requestContext = null;
export function beginMcpRequest(ctx = {}) {
  _mcpRequest = true;
  _requestContext = { ...ctx };
  return _requestContext;
}
export function endMcpRequest() {
  _mcpRequest = false;
  _requestContext = null;
}
export function requestContext() { return _requestContext; }
// WHO WROTE THIS ROW — an identity, not a timestamp.
//
// D4: suite group (a46) asserted "no row from THIS run is tagged live" by
// filtering the shared append-only log on `ts >= suiteStart`. That is a WALL
// CLOCK WINDOW over a file other processes append to, so a person using Claude
// normally while the suite ran turned their own correctly-tagged `live` rows
// into a suite failure: 896/1, the named queries never issued by the suite.
// A row now carries the id of the process that wrote it, and assertions filter
// on that instead of on time.
export function runId() {
  return process.env.MEMORY_RUN_ID || null;
}

// ---- a SCOPED source, for traffic this process generates about itself -----
//
// The recall canary (lib/recall-canary.js) calls latest() INSIDE the running server to check
// whether an unindexed file is answered honestly. That query is real — it goes through the real
// ranker and writes a real log row — and it is not a caller. It has to be labelled.
//
// 🟥 WHY AsyncLocalStorage AND NOT process.env. Setting MEMORY_QUERY_SOURCE around an `await` sets
// it for the whole PROCESS, and this process is a server: a person's query interleaving with the
// probe would be stamped 'canary' and vanish from the caller stats — the monitor corrupting the
// measurement it exists to protect. ALS is per async context, so only the probe's own call sees it.
//
// Precedence is innermost-first: an explicit scope beats the env var, which beats the MCP flag.
const QUERY_SOURCE_ALS = new AsyncLocalStorage();

/** Run `fn` with every query it issues tagged `src`. Returns whatever `fn` returns. */
export function withQuerySource(src, fn) { return QUERY_SOURCE_ALS.run(String(src), fn); }

export function querySource() {
  return QUERY_SOURCE_ALS.getStore() || process.env.MEMORY_QUERY_SOURCE || (_mcpRequest ? 'live' : 'unknown');
}
