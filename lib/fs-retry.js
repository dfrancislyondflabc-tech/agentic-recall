// lib/fs-retry.js — a rename that survives Windows.
//
// 🟥 THE PLATFORM DIFFERENCE, and why it is not paranoia. On POSIX, rename(2) over an existing
// path is atomic and cannot fail because someone has the target open — the old inode simply loses
// its last name. On Windows, MoveFileEx replaces the target only if NOTHING holds a handle to
// either path, and it returns EPERM / EBUSY / EACCES when something does. Three things routinely
// do: a real-time virus scanner that opened the file microseconds after it was written, a second
// capture process reading the run log, and Windows Defender's own indexer.
//
// Every rename in the capture path is the last step of a write-temp-then-swap, so a failure there
// is not cosmetic — it is the difference between an exchange landing in the store and an orphaned
// `.tmp` beside it. One retry after a short pause clears the transient holder in the cases
// measured; a second failure is re-thrown, because a rename that will not happen must not be
// swallowed into a silent half-write.
//
// The sleep is a BUSY WAIT on purpose: every caller here is synchronous code inside a script whose
// only job is this write, there is no event loop worth yielding to, and an async variant would
// force three call sites to become async for a 50 ms pause that happens almost never.

import { renameSync, rmSync } from 'node:fs';

/** Windows' vocabulary for "somebody else has this file open right now". */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

const spin = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* wait */ } };

/**
 * renameSync, retried once after `delayMs` when the failure is a Windows sharing violation.
 *
 * @param {string} from
 * @param {string} to
 * @param {{delayMs?:number, attempts?:number}} [opts]
 * @returns {{renamed:true, attempts:number}}
 * @throws whatever renameSync threw on the final attempt
 */
export function renameWithRetry(from, to, { delayMs = 50, attempts = 2 } = {}) {
  let last = null;
  for (let i = 1; i <= Math.max(1, attempts); i++) {
    try { renameSync(from, to); return { renamed: true, attempts: i }; }
    catch (e) {
      last = e;
      // ENOENT is not transient: the source is gone, and waiting cannot bring it back.
      if (!TRANSIENT.has(e.code) || i === attempts) throw e;
      spin(delayMs);
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------------------------
// 🟥 THE SAME PLATFORM DIFFERENCE, one directory up (MEM-69, 2026-09-05).
//
// A Windows PC running the shipped 1.7.1 public suite died with
// `EBUSY: resource busy or locked, rmdir 'C:\…\Temp\fresh-e2e-C4rOIw'` — AFTER 130/130 checks had
// passed — because a test removed its sandbox one line after asking a spawned server to stop. On
// POSIX an open file has no say in whether its directory entry goes away; on Windows a single open
// handle anywhere in the tree fails the whole rmdir, and the holders are routine: a child that has
// not finished exiting, a grandchild the parent's kill never reached, Defender's real-time scan, or
// the search indexer opening a file microseconds after it was written.
//
// Every one of those clears in tens of milliseconds. So the removal is a RETRY, not an assertion —
// and callers that are cleaning up (as opposed to removing something a later step depends on) are
// expected to swallow the final failure, log it, and carry on. A leaked temp directory is a
// housekeeping cost; a dead process loses whatever the run had left to do.
// ---------------------------------------------------------------------------------------------

/** Windows' vocabulary for "somebody still has a handle inside this tree". ENOTEMPTY belongs
 *  here too: recursive rm is depth-first, so a file it could not unlink surfaces as a parent that
 *  is not empty rather than as the sharing violation underneath. */
const TRANSIENT_RM = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'ENOTDIR']);

/**
 * rmSync(dir, {recursive, force}), retried while the failure looks like a Windows sharing
 * violation. Backs off linearly: attempt n waits n × delayMs, so six attempts at the default span
 * ~2.5 s — long enough for a scanner to let go, short enough that a genuinely stuck tree does not
 * stall a suite.
 *
 * ENOENT never reaches the caller: a directory that is already gone is the outcome asked for.
 *
 * @param {string} dir
 * @param {{attempts?:number, delayMs?:number, rm?:(p:string,o:object)=>void}} [opts]
 *        `rm` is injectable ONLY so a test can reproduce the Windows failure shape on a POSIX
 *        machine — holding an fd open there does not block unlink, so an honest test of this
 *        retry has to make the remove itself fail.
 * @returns {{removed:true, attempts:number}}
 * @throws whatever the final attempt threw
 */
export function rmDirWithRetry(dir, { attempts = 6, delayMs = 120, rm = null } = {}) {
  const doRm = rm || ((p) => rmSync(p, { recursive: true, force: true }));
  const max = Math.max(1, attempts);
  let last = null;
  for (let i = 1; i <= max; i++) {
    try { doRm(dir, { recursive: true, force: true }); return { removed: true, attempts: i }; }
    catch (e) {
      last = e;
      if (e.code === 'ENOENT') return { removed: true, attempts: i };
      if (!TRANSIENT_RM.has(e.code) || i === max) throw e;
      spin(delayMs * i);
    }
  }
  throw last;
}
