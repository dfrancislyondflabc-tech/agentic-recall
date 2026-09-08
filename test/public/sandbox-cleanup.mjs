// test/public/sandbox-cleanup.mjs — stop what the test started, then remove its sandbox, and
// NEVER fail the run over the removal.
//
// 🟥 THE BUG THIS FIXES (MEM-69, found on a Windows PC running the shipped 1.7.1 zip).
// `fresh-install-e2e.mjs` ended with:
//
//     srv.close();                                     // = child.kill()
//     rmSync(dir, { recursive: true, force: true });   // one line later
//
// On Windows that is three separate mistakes stacked:
//
//   1. `child.kill()` does not kill the process TREE. The server under test spawns the scheduler's
//      capture child, which spawns auto-ingest, which spawns ingest-transcript. Killing the parent
//      leaves grandchildren writing into the sandbox.
//   2. `child.kill()` is ASYNCHRONOUS — it posts the request and returns. Nothing waited for the
//      child's `exit`, so the rm began while the server was still shutting down even without any
//      grandchildren.
//   3. Windows cannot unlink a file somebody has open (POSIX can, which is exactly why this was
//      invisible on the Mac). `rmSync` threw `EBUSY: resource busy or locked, rmdir …`.
//
// The throw was uncaught, so the RUNNER DIED — after 130/130 checks had passed, with 32 later
// checks never running, on three runs out of three. A recipient following the shipped instructions
// sees a stack trace and a non-zero exit on a build where nothing is actually wrong.
//
// So the rules this file exists to make unmissable:
//
//   * stop a spawned child with `killTree()` and AWAIT its exit (bounded), never a bare kill();
//   * remove the sandbox with a retry, because on Windows a virus scanner or a lagging handle
//     makes EBUSY/EPERM/ENOTEMPTY a TRANSIENT condition, not a permanent one;
//   * and a cleanup that still fails after all that must LOG AND CONTINUE. A leaked temp directory
//     under %TEMP% is a housekeeping cost. A dead runner loses the assertions, which is the only
//     thing the suite is for. Cleanup is never an assertion.
//
// `run-public-tests.js` asserts STRUCTURALLY that every public test file which spawns a process or
// makes a temp dir imports this module — the missing import is precisely how MEM-69 happened, and
// a convention nobody checks is a convention that gets missed again.

import { rmDirWithRetry } from '../../lib/fs-retry.js';
import { killTree } from './kill-tree.mjs';

/**
 * Kill `child` and everything it spawned, then WAIT for the OS to reap it.
 *
 * The wait is the half that was missing. `killTree` issues the kill; this resolves only once the
 * child process object has emitted `exit` (or was already gone), which is the earliest moment
 * Windows can be expected to have released its handles on the sandbox.
 *
 * @param {import('node:child_process').ChildProcess|null|undefined} child
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{killed:boolean, how:string, exited:boolean, waitedMs:number}>}
 *          `exited:false` means the bound elapsed first — the caller carries on regardless; the
 *          rm retry is the second line of defence for exactly that case.
 */
export function stopChild(child, { timeoutMs = 5000 } = {}) {
  const t0 = Date.now();
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ killed: false, how: 'already gone', exited: true, waitedMs: 0 });
  }
  const k = killTree(child);
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ killed: k.killed, how: k.how, exited, waitedMs: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // `timer.unref` so a test that finishes early is not held open by this bound.
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', () => finish(true));
    child.once('close', () => finish(true));
    // The kill may have landed between the guard above and the listener being attached.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

/**
 * Remove a sandbox directory. NEVER THROWS.
 *
 * @param {string} dir
 * @param {{label?:string, attempts?:number, delayMs?:number, rm?:Function, log?:Function}} [opts]
 *        `rm` is injectable so a test can feed the Windows failure shape on a POSIX machine — an
 *        open fd does not block unlink here, so the only honest way to prove the retry works is to
 *        make the remove fail the way Windows makes it fail.
 * @returns {{removed:boolean, attempts:number, code:string|null}}
 */
export function cleanupSandbox(dir, { label = '', attempts = 6, delayMs = 120, rm, log } = {}) {
  if (!dir) return { removed: true, attempts: 0, code: null };
  const say = log || ((m) => console.log(m));
  try {
    const r = rmDirWithRetry(dir, { attempts, delayMs, rm });
    return { removed: true, attempts: r.attempts, code: null };
  } catch (e) {
    // 🟥 THE WHOLE POINT. Log it where a reader will see it, and let the run finish.
    say(`  warn  cleanup: could not remove ${label ? label + ' sandbox ' : ''}${dir} — ` +
      `${e.code || 'error'}: ${String(e.message).slice(0, 140)} (left behind; the run continues)`);
    return { removed: false, attempts, code: e.code || null };
  }
}

/**
 * The whole pattern in one call, for the common case: stop a server, then bin its sandbox.
 *
 * @param {object} o
 * @param {import('node:child_process').ChildProcess|{close?:Function, child?:object}|null} [o.child]
 * @param {string} [o.dir]
 * @param {string} [o.label]
 */
export async function stopAndClean({ child = null, dir = '', label = '', timeoutMs = 5000, rm, log } = {}) {
  let stopped = { killed: false, how: 'no child', exited: true, waitedMs: 0 };
  if (child) stopped = await stopChild(child, { timeoutMs });
  const cleaned = cleanupSandbox(dir, { label, rm, log });
  return { stopped, cleaned };
}
