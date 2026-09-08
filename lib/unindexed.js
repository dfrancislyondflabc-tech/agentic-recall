// lib/unindexed.js — THE STORE IS TRUTH; THE INDEX IS A CACHE.
//
// Every honesty guard in lib/search.js (recencyVoid, staleTermCollision, staleContentScan) is
// downstream of one fact: checkStaleness() knows exactly which store files the index has not read.
// Until now that knowledge was spent on WARNINGS — "N unread files are newer than results[0]" —
// and the caller was told to go and open them. This module opens them.
//
// WHY. In three weeks the pipeline conversation → capture → store file → index rebuild → server
// cache failed ~10 distinct ways (MEM-1, -2, -16/17, -18, -19, -20/F3, -21, v1.6.2's 7-hour stale
// cache, the v121 miss, MEM-26/27). Each was a different way for a file to be ON DISK and NOT IN
// THE INDEX. The newest exchange — the one a state question most wants — is exactly the file most
// likely to be in that gap. Reading the gap directly makes recent recall independent of whether an
// index rebuild ran; the index catches up in the background and nothing changes when it does.
//
// WHAT THIS IS NOT. It is not a second ranker. `latest()` is a FILTER ordered by time, so a directly
// read file that matches every term simply joins the list — that cannot regress a ranking. `search()`
// is a RANKER, so directly read files never enter its ranked list: they are returned BESIDE it under
// `recentUnindexed`, and the caller is told to read them. When `stamp._staleScan` is empty (the index
// is current) every code path here is skipped and the response is byte-identical to before.
//
// THE SAME GATES AS INDEXING. A file the indexer would have refused — denylisted name, or
// `metadata.secret: true` — is refused here too, through the same two functions (`exclusionReason`,
// `scrubSections`). A direct-read path that skipped them would re-open the hole loadCorpus closes.
//
// BOUNDED. At most `maxFiles` files / `maxBytes` bytes per query, newest first. Files the bound
// refused to open are reported as `unreadNewestMs` / `unreadNewestFiles`, which is what `latest`'s
// recency guard now warns about — a file that WAS read and did not match is honestly not the answer,
// exactly like an indexed non-match (Daniel, 2026-09-05: "narrow it — checked files don't warn").
//
// KILL SWITCH. MEMORY_UNINDEXED_DIRECT=0 disables the read and restores the warn-only behaviour.
// It doubles as the suite's mutation: with it set, the "returned" arm of (a25)/(a71) must fail and
// the "named" arm (recencyVoid) must fire.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { docFieldsFromFrontmatter, parseFrontmatter } from './corpus.js';
import { exclusionReason, scrubSections } from './secrets.js';

export const UNINDEXED_LIMITS = Object.freeze({
  maxFiles: Number(process.env.MEMORY_UNINDEXED_MAX_FILES ?? 50),
  maxBytes: Number(process.env.MEMORY_UNINDEXED_MAX_BYTES ?? 5 * 1024 * 1024)
});

export function unindexedDirectEnabled() {
  const v = process.env.MEMORY_UNINDEXED_DIRECT;
  return v !== '0' && v !== 'false';
}

// Parsed documents keyed by path:mtime:size, so a query burst over the same unindexed files parses
// each once. Small and bounded: the set of unindexed files is itself bounded by maxFiles.
const CACHE = new Map();
const CACHE_MAX = 200;

// Counted so a test can prove the fast path does NO I/O when nothing is unindexed.
let reads = 0;
export function _unindexedReadsForTests() { return reads; }
export function _resetUnindexedCacheForTests() { CACHE.clear(); reads = 0; }

const EMPTY = () => ({
  enabled: unindexedDirectEnabled(), docs: [], scanned: 0, total: 0, truncated: false,
  bytes: 0, excluded: 0, unreadable: 0, unreadNewestMs: null, unreadNewestFiles: []
});

/**
 * Read the store files the index has not seen, newest first, through the indexer's own gates.
 *
 * @param stamp  the freshness stamp from ensureFresh(); reads the non-enumerable `_staleScan`
 *               ([{fileId, path, mtimeMs}]) that attachStaleFiles() puts there on the stale branch.
 * @returns {{ enabled, docs, scanned, total, truncated, bytes, excluded, unreadable,
 *             unreadNewestMs, unreadNewestFiles }}
 *   docs carry the loadCorpus field shape plus `unindexed: true`, and a non-enumerable `__body`
 *   so bm25.js bodyOf() (and everything built on it — snippets, isCompactionSummary, countHits)
 *   works on them unchanged.
 */
export function readUnindexed(stamp, opts = {}) {
  const out = EMPTY();
  const files = stamp && stamp._staleScan;
  if (!files || !files.length) return out;
  // MEM-41. A file this module would REFUSE may still be named by the `unreadNewestFiles` list —
  // which is not a refusal, it is "the bound stopped me, go and read this yourself", printed
  // verbatim in recencyVoid's "READ THESE FIRST: …". checkStaleness marks those files and
  // attachStaleFiles carries the set here; they are counted (in `total`, and as `excluded` once
  // read) and never named.
  const gated = (stamp && stamp._gatedFileIds) || null;
  const nameable = (f) => !(gated && gated.has(f.fileId));
  // Switched off: read nothing, but still SAY how many files went unread, so the response carries
  // `unindexedChecked: { scanned: 0, total: N, disabled }` and a reader can see the switch is the
  // reason — silence here would be the exact failure mode this module exists to end.
  if (!out.enabled) {
    out.total = files.length;
    out.unreadNewestFiles = [...files].filter(nameable).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0)).slice(0, 15).map((f) => f.fileId);
    // The clock excludes gated files too: recencyVoid's warning is an instruction to go and read
    // named files, and a warning whose list is empty because everything in it was withheld is
    // noise a caller cannot act on. `gatedFiles` on the stamp says the withholding happened.
    const t = files.filter(nameable).map((f) => f.mtimeMs).filter((m) => Number.isFinite(m));
    out.unreadNewestMs = t.length ? Math.max(...t) : null;
    return out;
  }
  const maxFiles = Number.isFinite(Number(opts.maxFiles)) ? Number(opts.maxFiles) : UNINDEXED_LIMITS.maxFiles;
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) ? Number(opts.maxBytes) : UNINDEXED_LIMITS.maxBytes;

  // Newest first, so the bound (when it bites) drops the OLDEST unindexed files — the ones least
  // likely to be the answer to a recency question and most likely to be indexed already next tick.
  const sorted = [...files].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  out.total = sorted.length;

  const unread = [];   // files this call could not vouch for: over the bound, or unreadable
  for (const f of sorted) {
    if (out.scanned >= maxFiles || out.bytes > maxBytes) { unread.push(f); continue; }
    let st, raw;
    try {
      st = statSync(f.path);
      const key = `${f.path}:${st.mtimeMs}:${st.size}`;
      const hit = CACHE.get(key);
      if (hit) {
        out.scanned++;
        out.bytes += st.size;
        if (hit.doc) out.docs.push(hit.doc); else out.excluded++;
        continue;
      }
      raw = readFileSync(f.path, 'utf8');
      reads++;
    } catch {
      out.unreadable++;
      unread.push(f);
      continue;
    }
    out.scanned++;
    out.bytes += raw.length;
    const file = basename(f.path);
    const { front, body: rawBody } = parseFrontmatter(raw);
    const key = `${f.path}:${st.mtimeMs}:${st.size}`;
    // The indexer's refusal is this path's refusal. A denylisted or secret-marked file is
    // remembered as excluded (so the next query does not re-read it) and NEVER surfaces.
    if (exclusionReason(file, front)) {
      out.excluded++;
      remember(key, { doc: null });
      continue;
    }
    const { text: body, removed } = scrubSections(file, rawBody);
    const doc = docFieldsFromFrontmatter(front, body, {
      file, fileId: f.fileId, path: f.path, root: f.root || {}, st, raw, removed   // MEM-87: the real root, not {}
    });
    doc.unindexed = true;
    // bm25.js bodyOf() reads `__body` when present; index docs get it lazily from their chunks.
    Object.defineProperty(doc, '__body', { value: body, enumerable: false, writable: true, configurable: true });
    remember(key, { doc });
    out.docs.push(doc);
  }

  out.truncated = out.scanned < out.total;
  const unreadTimes = unread.filter(nameable).map((f) => f.mtimeMs).filter((m) => Number.isFinite(m));
  out.unreadNewestMs = unreadTimes.length ? Math.max(...unreadTimes) : null;
  out.unreadNewestFiles = unread
    .filter(nameable)
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 15)
    .map((f) => f.fileId);
  return out;
}

function remember(key, value) {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, value);
}

/** The one sentence every response carries when directly read files were merged or listed. */
export function unindexedGuidance(n, { merged }) {
  return merged
    ? `${n} exchange(s) below were read DIRECTLY from the store because the index has not seen them ` +
      "yet (provenance: 'unindexed-direct'). They are current. They carry no thread position and " +
      'no ranking score; the index will absorb them on its next rebuild and nothing here will change.'
    : `${n} file(s) NEWER than this index match your query and were NOT ranked (they are not in the ` +
      'index). They are listed under `recentUnindexed` — read them; the ranking below cannot see them.';
}
