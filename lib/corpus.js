// lib/corpus.js — read the memory folder into structured records.
//
// Handles the two shapes actually present in the corpus:
//   * ~98 files with YAML frontmatter {name, description, metadata:{...}}
//   * ~13 long-form runbooks with NO frontmatter — indexed anyway, with a
//     description synthesised from the first heading + first paragraph.
//
// Also extracts headings (a strong BM25 field) and [[wikilinks]] (the free
// relevance-expansion signal that `neighbors` exposes).

import { readdirSync, readFileSync, statSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { rewriteFrontmatterOnly } from './safe-write.js';
import { join, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { memoryDir, memoryRoots, secretsConfigPath } from './config.js';
import { warn } from './logger.js';
import { exclusionReason, scrubSections } from './secrets.js';
import { withSectionDocs, sectionDocsEnabled } from './section-docs.js';
import { attachKeyFacts } from './key-facts.js';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---- minimal YAML frontmatter parser -------------------------------------
// Deliberately not a YAML library: the corpus uses a fixed two-level shape
// (scalars at the top, one `metadata:` block of scalars). A hand parser keeps
// the dependency surface at zero and never reformats a file on write.
export function parseFrontmatter(raw) {
  // STRIP A BYTE-ORDER MARK FIRST. Windows editors (Notepad among them) write UTF-8 files with a
  // leading U+FEFF, which is invisible in every editor and makes `raw.startsWith('---')` false —
  // so the whole frontmatter block was read as BODY TEXT. The memory silently lost its name, its
  // type and its description, and got a synthesised description reading "--- name: ... ".
  // Measured on a fixture: type became 'memory' instead of 'project' and the description was the
  // raw frontmatter. Nothing warned, because from the parser's point of view the file simply had
  // no frontmatter. A corpus written on Windows would degrade one file at a time.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (!raw.startsWith('---')) return { front: null, body: raw.replace(/\r\n/g, '\n'), endIndex: 0 };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { front: null, body: raw.replace(/\r\n/g, '\n'), endIndex: 0 };
  const block = raw.slice(3, end);
  const afterIdx = raw.indexOf('\n', end + 1) + 1;
  // NORMALISE THE BODY'S LINE ENDINGS, ONCE, HERE. Fixing only the frontmatter left every
  // BODY parser carrying the same latent bug, and one of them was already live: extractHeadings
  // uses /^(#{1,6})\s+(.*)$/, and '.' does not match '\r', so a CRLF file yielded NO headings at
  // all. For a Windows user that silently removes `get outline`, `get section:"…"` and the
  // section splitter — the feature simply is not there, with no error to explain it.
  //
  // Doing it per-parser would have fixed the two that exist and left the trap set for the next
  // one. Line endings are not markdown semantics, so the body is served with '\n' regardless of
  // how it was written; offsets and totalChars are computed on this same normalised text, so
  // they stay self-consistent.
  const body = raw.slice(afterIdx).replace(/\r\n/g, '\n');

  const front = {};
  let container = front;
  // CRLF, AND WHY IT LOST EVERY FIELD. A Windows-authored file gives lines ending '\r', and in
  // JavaScript '.' does not match '\r' — it is a line terminator — so /^...(.*)$/ failed on EVERY
  // line and each was skipped by the `if (!m) continue` below. The result was frontmatter that
  // looked present (front !== null) with name, description and type all undefined: a nameless,
  // untyped memory, silently, for anyone using Notepad.
  //
  // Only the frontmatter BLOCK is normalised. The body keeps its bytes exactly as written, so
  // `get` still returns the file as it is on disk.
  const blockLines = block.split('\n').map((l) => l.replace(/\r$/, ''));
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, rawVal] = m;
    const val = stripQuotes(rawVal.trim());
    if (indent.length === 0) {
      // An empty value opens a nested block ONLY if the next meaningful line is
      // indented. `name:` with a trailing space and nothing under it is just an
      // empty string — treating it as a container crashes everything downstream.
      let nested = false;
      if (val === '') {
        for (let j = i + 1; j < blockLines.length; j++) {
          if (!blockLines[j].trim()) continue;
          nested = /^\s+\S/.test(blockLines[j]);
          break;
        }
      }
      if (nested) { front[key] = {}; container = front[key]; }
      else { front[key] = val; container = front; }
    } else {
      container[key] = val;
    }
  }
  return { front, body, endIndex: afterIdx };
}

function stripQuotes(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function extractHeadings(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) out.push(m[2].trim());
  }
  return out;
}

export function extractWikilinks(body) {
  const out = [];
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const slug = m[1].trim();
    if (slug) out.push(slug);
  }
  return [...new Set(out)];
}

/** Synthesise a description for a frontmatter-less runbook. */
export function synthDescription(body) {
  const lines = body.split('\n');
  let heading = '';
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (m) { heading = m[1].trim(); i++; break; }
    if (lines[i].trim()) break;
  }
  const para = [];
  for (; i < lines.length && para.length < 6; i++) {
    const t = lines[i].trim();
    if (!t) { if (para.length) break; continue; }
    if (/^#{1,6}\s/.test(t)) { if (para.length) break; continue; }
    para.push(t);
  }
  const text = [heading, para.join(' ')].filter(Boolean).join(' — ');
  return (text.replace(/\s+/g, ' ').slice(0, 400) || '(no description)');
}

/**
 * Read every .md in the memory dir.
 * Returns { docs, excluded, skipped } — excluded entries carry a reason and are NEVER
 * given a body, not even in memory; `skipped` counts and names files that hold no content at all
 * (MEM-56), which are not the same thing: nothing about them was refused, there is nothing there.
 */
/** A bare path still means "one primary root", so every existing caller works. */
function normaliseRoots(dirOrRoots) {
  if (typeof dirOrRoots === 'string') return [{ dir: dirOrRoots, label: null, defaultTier: 'hot', primary: true }];
  return dirOrRoots;
}

/**
 * WHICH FILES ARE THE CORPUS — the single enumeration rule, no content read.
 *
 * loadCorpus() and the staleness guard (lib/freshness.js) MUST agree on this
 * exactly: a guard that enumerates the corpus differently from the indexer
 * either misses an edit or reports a phantom one forever. So there is one
 * function, and both call it.
 *
 * `root.match`, when present, is a list of regexes the BARE filename must match
 * — that is what lets a root directory holding unrelated .md files contribute
 * only its handoff documents.
 */
/**
 * Is `candidate` really inside `rootDir` once every symlink is resolved?
 *
 * realpathSync on BOTH sides: the root itself may legitimately be a symlink (a corpus under
 * /tmp on macOS is really /private/tmp), and comparing a resolved file against an unresolved
 * root would then reject every file in it.
 *
 * A path that cannot be resolved — a dangling symlink, a file deleted between the readdir and
 * this call — is refused. An unreadable entry is not a memory, and failing closed is the right
 * direction for a boundary check.
 */
function withinRoot(candidate, rootDir, realRoot) {
  try {
    // 🟥 lstat FIRST. Only a symlink can leave the root, so resolving every plain file costs a
    // syscall per file for nothing — and this runs on every freshness check, twice per corpus
    // load. Measured on a 2,764-file corpus: realpath-everything 72 ms, lstat-first 9 ms. The
    // first version of this guard did the expensive thing and shipped an 8x slowdown on a hot
    // path to close a hole that only symlinks can open. Same shape as escapesRoot() in
    // lib/import-sources.js, which got it right.
    if (!lstatSync(candidate).isSymbolicLink()) return true;
    const realFile = realpathSync(candidate);
    return realFile === realRoot || realFile.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  } catch {
    return false;      // unresolvable or vanished — refuse rather than guess
  }
}

// ---- THE SOURCE LISTING: ONE CHEAP ANSWER TO "IS THE INDEX BEHIND THE FOLDER?" -----------------
//
// A writer that decides whether to rebuild has to compare the index against the STORE, and it has
// to do it without parsing a 130 MB index. So the index header records a digest of exactly what it
// was built from — every corpus file's id, mtime and size — and a later run recomputes the same
// digest from the directory in a few milliseconds and compares two strings.
//
// 🟥 ONE FUNCTION, TWO CALLERS, DELIBERATELY. lib/index-store.js stamps it at build time and
// scripts/auto-ingest.js recomputes it at check time. If those were two implementations they would
// drift, and the failure of a drifted digest is PERMANENT DISAGREEMENT — a rebuild on every single
// tick, or, worse, a mismatch that can never be cleared. They must be the same code.
//
// NOT `docCount`. The document count is not the file count: exclusions remove files and section
// splitting adds documents, so comparing counts answers a different question. This is the file set.
// And NOT `corpusHash` either — that one hashes CONTENT and is the authority on what was indexed;
// this is the cheap stat-only proxy that decides whether the expensive check is worth running.

/** The digest half, over pre-statted entries. Sorted, so directory order cannot change it. */
export function sourceListingDigest(entries) {
  const parts = (entries || [])
    .map((e) => `${e.fileId}:${e.mtimeMs}:${e.size}`)
    .sort();
  return { count: parts.length, digest: sha256(parts.join('\n')) };
}

/**
 * The same digest, computed from a directory (or root list) with one stat per file.
 * Files that vanish mid-pass are skipped, exactly as statSourceFiles() skips them, so the two
 * entry points cannot disagree about a file that is not there.
 */
export function sourceListingOf(dirOrRoots = memoryRoots()) {
  const entries = [];
  for (const entry of listCorpusFiles(dirOrRoots)) {
    let st; try { st = statSync(entry.path); } catch { continue; }
    entries.push({ fileId: entry.fileId, mtimeMs: st.mtimeMs, size: st.size });
  }
  return sourceListingDigest(entries);
}

export function listCorpusFiles(dirOrRoots = memoryRoots()) {
  const roots = normaliseRoots(dirOrRoots);
  const out = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;      // an absent root is not an error
    // Resolved ONCE per root, not once per file.
    let realRoot; try { realRoot = realpathSync(root.dir); } catch { continue; }
    const files = readdirSync(root.dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => !root.match || root.match.some((re) => re.test(f)))
      .sort();
    for (const file of files) {
      // 🟥 THE CORPUS BOUNDARY IS THE REAL PATH, NOT THE LISTED ONE.
      //
      // A symlink inside the corpus directory used to be followed straight out of it. Planting
      // `passwd.md -> /etc/passwd` got /etc/passwd indexed, searchable, and returned in full by
      // `get`; a symlink to any readable file did the same. The effective boundary was not
      // MEMORY_DIR but "everything reachable from MEMORY_DIR" — and the contents end up in an
      // index on disk and in a model's context.
      //
      // It needs write access to the corpus directory, which is not a high bar in the cases that
      // matter: a corpus in a git repo or a synced folder, one that more than one person writes
      // to, or a user who symlinks notes in without realising the whole target gets ingested.
      //
      // Same defence as validatePath() in the author's cli-mcp-server: resolve with realpath and
      // refuse anything landing outside the root. A symlink WITHIN the corpus is still fine —
      // that is a legitimate way to organise notes.
      const full = join(root.dir, file);
      if (!withinRoot(full, root.dir, realRoot)) continue;
      out.push({
        file,
        fileId: root.label ? `${root.label}/${file}` : file,
        path: full,
        root
      });
    }
  }
  return out;
}

// A CHEAP VALIDITY CHECK IN FRONT OF AN EXPENSIVE READ. loadCorpus() reads and parses EVERY
// file in the corpus, and get() and neighbors() both call it per request — so on a 600-document
// corpus a single `get` of one memory cost 586 ms, twenty times a whole hybrid search (32 ms),
// because it re-read 599 documents it did not want. That is the action the absence layer tells
// a caller to run when it says "open bestWeak[0] and read it", so it is the worst one to be slow.
//
// The cache is validated by STAT, not by time: list the files and take mtime+size for each, which
// costs a few milliseconds, and rebuild only when that signature changes. Same discipline as
// jsonFileMemo() — a memo keyed on a clock is a memo that serves stale content, and this corpus
// is edited by the user WHILE the server runs, so nothing may be assumed to stay put.
let CORPUS_CACHE = null;
function corpusSignature(roots) {
  const parts = [];
  for (const entry of listCorpusFiles(roots)) {
    let st; try { st = statSync(entry.path); } catch { continue; }
    parts.push(`${entry.path}:${st.mtimeMs}:${st.size}`);
  }
  return parts.join('|');
}
// THE PARSE DEPENDS ON MORE THAN THE FILES. Key facts, section splitting and the secrets policy
// all change what loadCorpus() RETURNS for identical bytes on disk — so a memo keyed on file
// mtimes alone serves a stale shape the moment a flag moves. That is not hypothetical: keyed on
// files only, this cache broke the key-facts suite, which flips MEMORY_KEY_FACTS between calls
// and then reads the field that flag controls.
//
// Every MEMORY_* variable is folded in rather than an enumerated list, because an enumerated
// list is a thing that goes out of date silently — the failure mode being fixed here.
function configSignature() {
  const env = Object.keys(process.env).filter((k) => k.startsWith('MEMORY_')).sort()
    .map((k) => `${k}=${process.env[k]}`).join(';');
  let sec = '';
  try { const st = statSync(secretsConfigPath()); sec = `${st.mtimeMs}:${st.size}`; } catch { sec = 'absent'; }
  return `${env}##${sec}`;
}
/** Drop the memo — for tests, and for anything that edits the corpus in-process. */
export function forgetCorpusCache() { CORPUS_CACHE = null; }

/**
 * ONE mapper from a parsed file to the document shape, shared by loadCorpus (index time) and
 * lib/unindexed.js (query time, for store files the index has not read yet). Two copies of this
 * literal would drift — the index-time copy already grew nine fields in three weeks — and a
 * drift here is invisible until a directly read exchange ranks or filters differently from the
 * same exchange once indexed. So there is one.
 *
 * @param front    parsed frontmatter (may be null)
 * @param body     the body AFTER scrubSections
 * @param ctx      { file, fileId, path, root, st, raw, removed }
 */
export function docFieldsFromFrontmatter(front, body, { file, fileId, path, root = {}, st, raw, removed = [] }) {
  const name = (front?.name || basename(file, '.md')).trim();
  const description = (front?.description || synthDescription(body)).trim();
  const meta = front?.metadata || {};
  return {
    name,
    file: fileId,
    path,
    root: root.label || null,
    hasFrontmatter: !!front,
    description,
    descriptionSynthesised: !front?.description,
    // `root.docType` is how the handoff corpus gets type: 'handoff-doc'
    // without a frontmatter block it does not have and must not be given —
    // these files are read-only.
    type: meta.type || meta.node_type || root.docType || 'memory',
    // READ-ONLY travels with the document, not with the caller. doTier()
    // refuses to write to one, so no MCP action can demote, promote or
    // otherwise touch a file this server only has permission to read.
    readOnly: !!root.readOnly,
    // Carried so retrieval can be SCOPED to one conversation. The extractor
    // stamps both; a hand-written memory simply has neither.
    sessionId: meta.sessionId || meta.originSessionId || null,
    // WHAT WAS BEING ASKED when this memory was written. A rule aimed at one session was
    // once captured as a universal standing rule, and a later session pointed at different
    // work refused that work because of it. Nothing recorded who the instruction was for.
    // Stamped by scripts/stamp-memory-account.js; absent on everything written before it.
    originTask: meta.originTask || null,
    // ONLY frontmatter. The root's account label is NOT a fallback, because a
    // root label describes WHO IS READING and this field must describe WHO
    // WROTE. Inheriting it made an old unlabelled memory come back stamped
    // "work" simply because the work surface opened it — attribution that
    // changes with the reader is worse than no attribution.
    // Unlabelled stays null, and the account filter never drops null, so those
    // memories remain visible to every account.
    account: meta.account || null,
    project: meta.project || root.project || null,
    sessionTitle: meta.sessionTitle || null,
    // STILL BEING WRITTEN WHEN CAPTURED. Stamped by the hook path when the final exchange has no
    // later human turn (scripts/ingest-transcript.js). Carried here so a reader can be TOLD, which
    // is the whole point: on 2026-09-04 a chat read a half-written reply, reported a finding that
    // the same answer went on to retract, and nothing in the response could have warned it.
    inFlight: meta.inFlight === true || String(meta.inFlight).toLowerCase() === 'true',
    ts: meta.ts || null,
    // Frontmatter wins; otherwise the ROOT decides. That is what makes the
    // own-store append-only half arrive at archive tier without every writer
    // having to remember to say so.
    tier: (() => {
      const t = String(meta.tier || '').toLowerCase();
      if (t === 'archive' || t === 'hot') return t;
      return root.defaultTier || 'hot';
    })(),
    // Whether the AUTHOR set the tier. File-version demotion (below) defers
    // to an explicit tier — the same precedence this loader already gives it.
    tierExplicit: ['archive', 'hot'].includes(String(meta.tier || '').toLowerCase()),
    // PHASE 3a (dark) — machine-checkable current truth, PARSED AND CARRIED.
    // These four used to be parsed-and-dropped like any unknown metadata key.
    // `probe` is a recorded command from the CLOSED vocabulary in
    // lib/probes.js; `probe_expected` the recorded expected value; `asOf`
    // when the claim was made; `validUntil` an author-declared expiry.
    // Nothing here executes at load or at query time — the nightly sweep
    // owns execution and writes verdicts to a sidecar only.
    probe: meta.probe || null,
    probeExpected: meta.probe_expected ?? null,
    asOf: meta.asOf || null,
    validUntil: meta.validUntil || null,
    modified: meta.modified || new Date(st.mtimeMs).toISOString(),
    // WHAT KIND of claim `modified` is: 'stop-hook' (real fact-time), 'git-floor' (a floor), or
    // null (mtime). Parsed-and-dropped until 2026-09-05; carried so corpusClock() can say when a
    // curated corpus really is time-ordered instead of labelling every curated order "mtime".
    modifiedSource: meta.modifiedSource || null,
    mtimeMs: st.mtimeMs,
    size: st.size,
    hash: sha256(raw),
    headings: extractHeadings(body),
    links: extractWikilinks(body),
    scrubbedSections: removed,
    body
  };
}

export function loadCorpus(dirOrRoots = memoryRoots()) {
  const roots = normaliseRoots(dirOrRoots);
  const sig = `${JSON.stringify(roots.map((r) => r.dir))}::${configSignature()}::${corpusSignature(roots)}`;
  if (CORPUS_CACHE && CORPUS_CACHE.sig === sig) return CORPUS_CACHE.value;

  const docs = [];
  const excluded = [];
  // 🟥 A FILE WITH NO CONTENT IS NOT A DOCUMENT (MEM-56 / campaign C, C-6). An empty store file
  // used to become a zero-chunk phantom: docCount 5 -> 6 while chunkCount stayed at 10, the
  // phantom counted in `sourceListing.count`, in the canary's visible/pending arithmetic, and in
  // every "N documents" a reader is shown — and NOTHING named it. Harmless to answers, but the
  // bar is that a build names what it did. Named here, counted in the header, skipped from the
  // corpus. Deliberately NARROW: whitespace-only RAW text. A file with frontmatter and an empty
  // body is a real document with metadata and stays one.
  const skipped = { empty: 0, names: [] };
  const MAX_NAMED_SKIPPED = 20;
  // root label (null = the canonical/primary root) -> the names ITS MEMORY.md lists
  const memoryIndexNames = new Map();

  {
  for (const entry of listCorpusFiles(roots)) {
    const { file, fileId, path: full, root } = entry;
    // 🟥 ONE UNREADABLE FILE MUST NOT TAKE THE WHOLE MEMORY OFFLINE.
    //
    // These two calls were unguarded, and loadCorpus is on the path of search, get, neighbors AND
    // the indexer. So a single `chmod 000` file, or a file deleted between listCorpusFiles() and
    // this read, threw out of the loop and every query answered "no index — run npm run index" —
    // advice that could not help, because the rebuild threw the same error. Worse, asking for a
    // healthy memory returned an ENOENT naming a DIFFERENT file, which is the worst possible
    // pointer.
    //
    // The delete case is not contrived: this file's own cache comment says the corpus "is edited
    // by the user WHILE the server runs", so a routine `rm` is a TOCTOU between the listing and
    // the read.
    //
    // Same discipline as everywhere else here — an absent root is "not an error", excluded files
    // are collected and named. Skip it, record why, keep serving the other memories.
    let st, raw;
    try {
      st = statSync(full);
      raw = readFileSync(full, 'utf8');
    } catch (e) {
      excluded.push({ file: fileId, name: basename(file, '.md'), reason: `unreadable (${e.code || e.message})` });
      continue;
    }
    if (!raw.trim()) {
      skipped.empty++;
      if (skipped.names.length < MAX_NAMED_SKIPPED) skipped.names.push(fileId);
      continue;
    }

    const { front, body: rawBody } = parseFrontmatter(raw);

    const reason = exclusionReason(file, front);
    if (reason) {
      excluded.push({ file: fileId, name: basename(file, '.md'), reason });
      continue;
    }

    // Mechanism 3 — strip configured sections BEFORE anything sees the body.
    const { text: body, removed } = scrubSections(file, rawBody);

    docs.push(docFieldsFromFrontmatter(front, body, { file, fileId, path: full, root, st, raw, removed }));
  }
  }

  // MEMORY.md is the hand-curated tier-1 index: anything it names is hot by
  // definition, and gets the larger of the two hot boosts.
  //
  // PER ROOT, because every project's memory folder has its own MEMORY.md and it
  // indexes ITS OWN memories. Keying on the un-namespaced `MEMORY.md` found only
  // the canonical folder's, so another project's index file was inert — its
  // hand-picked tier-1 entries got the smaller boost — while the canonical one's
  // entries were matched by NAME against every root, which could promote an
  // unrelated document that happened to share a name.
  for (const d of docs) {
    if (basename(d.file) !== 'MEMORY.md') continue;
    const names = new Set();
    for (const slug of d.links) names.add(slug);
    for (const m of d.body.matchAll(/\]\(([^)]+\.md)\)/g)) names.add(basename(m[1], '.md'));
    memoryIndexNames.set(d.root || null, names);
  }
  for (const d of docs) {
    const names = memoryIndexNames.get(d.root || null);
    d.inMemoryIndex = !!names && (names.has(d.name) || names.has(basename(d.file, '.md')));
    // "MEMORY.md-listed entries are hot by definition."
    if (d.inMemoryIndex && d.tier === 'archive') d.tier = 'hot';
  }

  // A doc is addressed by NAME (resolveDoc, the backlink map, memory({get})).
  // Two docs sharing one name means the second is unreachable — get() returns
  // the first, and nothing says so. Primary-root docs are loaded first, so a
  // curated memory always wins a cross-root clash; what needs saying out loud
  // is that the loser exists. Auto-ingest makes this reachable in practice: an
  // extractor that derives names from a conversation WILL collide unless it
  // qualifies them per session.
  {
    const seen = new Map();
    for (const d of docs) {
      if (seen.has(d.name)) {
        warn(`duplicate name "${d.name}": ${d.file} is shadowed by ${seen.get(d.name)} — get()/backlinks will only ever reach the first`);
      } else seen.set(d.name, d.file);
    }
  }

  // PHASE 2b -- FILE-LEVEL VERSION DEMOTION, B2's arithmetic on sibling files.
  // release-v107-shipped competes at hot tier with release-v112-shipped for every
  // "what shipped" query, and tier demotion had been used on 0 of 140 files by
  // hand. Same rule that governed section demotion: position in a NAME'S
  // version sequence is arithmetic; keep the newest 3, archive the rest.
  // Placed BEFORE sectioning so a demoted file's children inherit archive, and
  // AFTER the MEMORY.md-listed-means-hot pass DELIBERATELY: a superseded
  // version stays listed in the lineage forever, and the listing is
  // navigation, not currency — the exact reasoning B2 used inside the
  // changelog. Flag-gated, default OFF until its pre-registered bar passes
  // (test/file-version-demotion-preregistration.md).
  applyFileVersionDemotion(docs);

  // PHASE B -- section children, if the flag is on. Placed BEFORE backlinks so
  // a child inherits nothing stale: children carry no links of their own, and
  // the parent stub keeps the document's own link graph intact.
  let sectionReport = null;
  if (sectionDocsEnabled()) {
    const r = withSectionDocs(docs, { synthDescription });
    sectionReport = { split: r.split, added: r.added };
    docs.length = 0;
    docs.push(...r.docs);
  }

  // PHASE 4b -- key facts, AFTER the split because the keys are per section.
  // A no-op (not even a stat) while MEMORY_KEY_FACTS is off.
  attachKeyFacts(docs);

  // Backlinks
  const byName = new Map(docs.map((d) => [d.name, d]));
  const bySlug = new Map(docs.map((d) => [basename(d.file, '.md'), d]));
  // A note that links to ITSELF is not related to itself. `backlinks` below already excludes
  // self (`target.name !== d.name`); `links` did not, so the two sides disagreed and a
  // self-reference showed up as an outbound relationship in `get` and `neighbors`. Cosmetic —
  // it was verified not to affect scoring — but the asymmetry was the kind that gets read as
  // a real edge later.
  for (const d of docs) d.links = d.links.filter((l) => l !== d.name && l !== basename(d.file, '.md'));
  for (const d of docs) d.backlinks = [];
  for (const d of docs) {
    for (const slug of d.links) {
      const target = byName.get(slug) || bySlug.get(slug);
      if (target && target.name !== d.name) target.backlinks.push(d.name);
    }
  }
  for (const d of docs) d.backlinks = [...new Set(d.backlinks)].sort();

  const _result = { docs, excluded, skipped, dir: roots[0]?.dir, roots, sectionReport };
  CORPUS_CACHE = { sig, value: _result };
  return _result;
}

export function resolveDoc(docs, name) {
  const want = String(name || '').trim().replace(/\.md$/i, '').toLowerCase();
  return (
    docs.find((d) => d.name.toLowerCase() === want) ||
    // THE NAMESPACED ID, tried before the bare basename. Every project's memory
    // folder has a MEMORY.md, and two documents with one name means the second is
    // unreachable — loadCorpus warns about exactly this. `cli-mcp-server/MEMORY`
    // is the way to ask for the other one, and without this branch there was no
    // way at all.
    docs.find((d) => d.file.replace(/\.md$/i, '').toLowerCase() === want) ||
    docs.find((d) => basename(d.file, '.md').toLowerCase() === want) ||
    docs.find((d) => d.name.toLowerCase().replace(/[^a-z0-9]/g, '') === want.replace(/[^a-z0-9]/g, '')) ||
    null
  );
}

// ---- tier mechanics (demote / promote) ------------------------------------
// NEVER deletes or moves content. Only sets/removes metadata.tier in the
// file's frontmatter, creating a frontmatter block if the file lacks one.
// ---- FILE-LEVEL VERSION DEMOTION (Phase 2b) ---------------------------------
// Flag: MEMORY_FILE_VERSION_DEMOTION (default OFF until the pre-registered bar
// in test/file-version-demotion-preregistration.md passes). Arithmetic only:
// a curated file whose NAME carries exactly ONE version token joins the group
// of its token-normalised stem; a group of >= 3 keeps its newest
// MEMORY_FILE_KEEP_VERSIONS (3) and demotes the rest to archive. Exclusions,
// each pinned by test: zero tokens (no group), >= 2 tokens (a RANGE document
// like release-v105-v106-shipped belongs to no single era), groups under 3, files
// whose author set tier explicitly, and non-canonical roots.
export const fileVersionDemotionEnabled = () =>
  process.env.MEMORY_FILE_VERSION_DEMOTION === '1' || process.env.MEMORY_FILE_VERSION_DEMOTION === 'true';
const keepFileVersions = () => Number(process.env.MEMORY_FILE_KEEP_VERSIONS || 3);

export function applyFileVersionDemotion(docs) {
  if (!fileVersionDemotionEnabled()) return docs;
  const groups = new Map();
  for (const d of docs) {
    if (d.root !== null || d.readOnly || d.parentName) continue;   // canonical curated files only
    if (d.tierExplicit) continue;                                  // the author's word outranks arithmetic
    const toks = [...String(d.name).matchAll(/\bv(\d{1,4})\b/gi)];
    if (toks.length !== 1) continue;                               // zero tokens or a range — excluded
    const stem = String(d.name).replace(toks[0][0], 'v*');
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push({ d, v: Number(toks[0][1]) });
  }
  for (const members of groups.values()) {
    if (members.length < 3) continue;                              // a pair is not a sequence
    members.sort((a, b) => b.v - a.v);
    for (const m of members.slice(keepFileVersions())) m.d.tier = 'archive';
  }
  return docs;
}

// ---- REAL FACT-TIME (Phase 2a) ----------------------------------------------
// `modified` was a lie for 110 of 140 curated files: the 2026-08-19 account
// backfill rewrote every mtime in one pass, so "newest first" ordered by
// bookkeeping. The fix is an EXPLICIT stamp — metadata.modified, the exact key
// loadCorpus already prefers over mtime — written by the Stop hook when a file
// changes, and once by a git-floor backfill for the pre-hook era.
//
// FRONTMATTER-ONLY SURGERY, the setTier discipline: the body is never touched,
// split, or reordered, so the incremental indexer's body-keyed vector reuse
// holds (test a19 pins that a frontmatter edit does not re-embed). A file with
// NO frontmatter is REFUSED rather than given one: the only such file is
// MEMORY.md, which is loaded verbatim into Claude's context every session — a
// YAML block prepended there would be prompt pollution, not metadata.
//
// `modifiedSource` records what kind of claim the date is: 'stop-hook' = the
// commit that carried the change (real fact-time from here on); 'git-floor' =
// the newest memory-repo commit touching the file (a floor, not fact-time —
// the repo only exists since 2026-08-23). Never inferred from body text.
export function setModified(fullPath, iso, source = null) {
  const raw = readFileSync(fullPath, 'utf8');
  const { front } = parseFrontmatter(raw);
  if (!front) return { changed: false, reason: 'no frontmatter — refusing to create one for a date stamp' };

  const end = raw.indexOf('\n---', 3);
  const block = raw.slice(3, end);
  const rest = raw.slice(end);
  const lines = block.split('\n');

  const stamp = `  modified: ${iso}`;
  const modIdx = lines.findIndex((l) => /^\s+modified\s*:/.test(l));
  const srcIdx = lines.findIndex((l) => /^\s+modifiedSource\s*:/.test(l));
  const metaIdx = lines.findIndex((l) => /^metadata\s*:/.test(l));

  if (modIdx !== -1) {
    if (lines[modIdx] === stamp) return { changed: false, reason: 'already stamped with this value' };
    lines[modIdx] = stamp;
    if (source) {
      if (srcIdx !== -1) lines[srcIdx] = `  modifiedSource: ${source}`;
      else lines.splice(modIdx + 1, 0, `  modifiedSource: ${source}`);
    }
  } else if (metaIdx !== -1) {
    lines.splice(metaIdx + 1, 0, stamp, ...(source ? [`  modifiedSource: ${source}`] : []));
  } else {
    lines.push('metadata:', stamp, ...(source ? [`  modifiedSource: ${source}`] : []));
  }

  const w = rewriteFrontmatterOnly(fullPath, '---' + lines.join('\n') + rest);
  if (!w.written) return { changed: false, reason: w.refused };
  return { changed: true };
}

export function setTier(fullPath, tier /* 'archive' | null */) {
  const raw = readFileSync(fullPath, 'utf8');
  const { front } = parseFrontmatter(raw);
  const name = basename(fullPath, '.md');
  let out;

  if (!front) {
    if (tier === null) return { changed: false, reason: 'no frontmatter, nothing to promote', createdFrontmatter: false };
    const desc = synthDescription(raw).replace(/"/g, "'");
    out = `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  node_type: memory\n  type: memory\n  tier: archive\n---\n\n${raw}`;
    const w0 = rewriteFrontmatterOnly(fullPath, out, { allowNewFrontmatter: true });
    if (!w0.written) return { changed: false, reason: w0.refused, createdFrontmatter: false };
    return { changed: true, createdFrontmatter: true, tier: 'archive' };
  }

  const end = raw.indexOf('\n---', 3);
  const block = raw.slice(3, end);
  const rest = raw.slice(end);
  const lines = block.split('\n');

  const tierIdx = lines.findIndex((l) => /^\s+tier\s*:/.test(l));
  const metaIdx = lines.findIndex((l) => /^metadata\s*:/.test(l));

  if (tier === null) {
    if (tierIdx === -1) return { changed: false, reason: 'already hot', tier: 'hot' };
    lines.splice(tierIdx, 1);
  } else if (tierIdx !== -1) {
    if (/tier\s*:\s*archive\s*$/.test(lines[tierIdx])) {
      return { changed: false, reason: 'already archived', tier: 'archive' };
    }
    lines[tierIdx] = '  tier: archive';
  } else if (metaIdx !== -1) {
    lines.splice(metaIdx + 1, 0, '  tier: archive');
  } else {
    lines.push('metadata:', '  tier: archive');
  }

  out = '---' + lines.join('\n') + rest;
  const w = rewriteFrontmatterOnly(fullPath, out);
  if (!w.written) return { changed: false, reason: w.refused, createdFrontmatter: false };
  return { changed: true, createdFrontmatter: false, tier: tier === null ? 'hot' : 'archive' };
}
