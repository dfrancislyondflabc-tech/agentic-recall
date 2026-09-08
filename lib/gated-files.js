// lib/gated-files.js — A FILE THE INDEXER REFUSES MAY NOT BE NAMED BY A WARNING EITHER.
//
// THE FINDING (2026-09-05, big-test P-1; MEM-41). lib/unindexed.js honours the indexer's gates
// exactly — a denylisted filename or `metadata.secret: true` is read, refused, and never surfaces,
// and probe A8 confirmed no gated BODY reaches a response. But the three PRE-1.7 honesty channels
// were written before those gates existed as a query-time concern, and they say the filename out
// loud:
//
//   staleTermCollision   "v111 matches no INDEXED document, but it appears in the NAME of …"
//   staleContentScan     reads every stale file and reports "gatedtoken55 appears in
//                        \"store/private-credentials.md\""
//   attachStaleFiles     staleFilesAdded / staleFilesChanged, which also feed recencyVoid's
//                        "READ THESE FIRST: …" list
//   staleWarningText     "2 added (private-credentials.md, …)"
//
// Asked for a password-shaped token, the response CONFIRMED the token is inside the denylisted
// file and told the reader to go and open it. That is the disclosure the denylist exists to
// prevent — build-public-tree.sh states the principle: publishing such a name "does not just leak
// a filename, it publishes WHERE the author keeps a credential."
//
// SO THE GATE MOVES UPSTREAM OF EVERY NAME. checkStaleness() is the single place that decides which
// files are "stale", and every channel above is downstream of its lists. It now marks the gated
// ones, the named lists drop them, and lib/search.js attachStaleFiles keeps them out of the
// non-enumerable `_staleScan` that the content scan and lib/unindexed.js read.
//
// THE RESPONSE STAYS HONEST. The gated files remain in `changed`/`added`, so `staleFiles`, the
// `stale` verdict and the rebuild trigger are unchanged — a file whose exclusion could itself have
// changed still earns a rebuild. What the caller loses is only the NAME; it gains `gatedFiles: N`,
// which says plainly that N files were withheld and why, without saying which.
//
// COST. Almost all of it is free. checkStaleness already knows the index's own verdict for every
// file it has seen (`idx.excluded`), so only files the index has NEVER seen need a look, and only
// those whose NAME is not already denylisted need a read. On a healthy index that set is empty and
// this module does no I/O at all.

import { closeSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { parseFrontmatter } from './corpus.js';
import { exclusionReason } from './secrets.js';

// Enough for any frontmatter block this project writes (the largest in the corpus is ~1.5 KB).
const HEAD_BYTES = 64 * 1024;

// path:mtimeMs:size -> reason|null. Bounded; the set of unindexed files is itself bounded.
const CACHE = new Map();
const CACHE_MAX = 500;

let reads = 0;
export function _gateReadsForTests() { return reads; }
export function _resetGateCacheForTests() { CACHE.clear(); reads = 0; }

/**
 * Would the indexer refuse this file? Returns the reason string, or null.
 *
 * FAILS CLOSED, deliberately and in the safe direction: a file that cannot be opened, or whose
 * frontmatter does not terminate inside the head we read, is treated as GATED. The cost of being
 * wrong is one filename withheld from a warning; the cost of the other default is the disclosure
 * this module exists to stop.
 */
export function gateReason(path, { mtimeMs = null, size = null } = {}) {
  const file = basename(path);
  // Mechanism 1 is name-only, so it needs no read at all — and it is the common case.
  const byName = exclusionReason(file, null);
  if (byName) return byName;

  const key = `${path}:${mtimeMs}:${size}`;
  if (CACHE.has(key)) return CACHE.get(key);

  let head;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      head = buf.slice(0, n).toString('utf8');
    } finally { closeSync(fd); }
    reads++;
  } catch {
    return 'unreadable';          // not cached: a transient ENOENT must not stick
  }

  let reason;
  if (head.startsWith('---') || head.charCodeAt(0) === 0xFEFF) {
    const { front } = parseFrontmatter(head);
    // An opening `---` with no closing one inside HEAD_BYTES: we cannot see metadata.secret, so
    // we do not get to claim it is absent.
    reason = front === null ? 'frontmatter-unterminated' : exclusionReason(file, front);
  } else {
    reason = null;                // no frontmatter at all — nothing to opt out with
  }
  remember(key, reason);
  return reason;
}

function remember(key, value) {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, value);
}

/**
 * The subset of `[{fileId, path, mtimeMs, size}]` the indexer would refuse, as a Set of fileIds.
 * `known` pre-seeds ids whose verdict the caller already has (checkStaleness passes the index's
 * own `excluded` list), so those cost nothing.
 */
export function gatedIdsAmong(files, known = null) {
  const out = new Set();
  for (const f of files || []) {
    if (known && known.has(f.fileId)) { out.add(f.fileId); continue; }
    if (gateReason(f.path, f)) out.add(f.fileId);
  }
  return out;
}
