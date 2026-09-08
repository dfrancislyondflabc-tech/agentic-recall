// lib/child.js — every child process this project starts, started WITHOUT a console window.
//
// 🟥 MEM-83. On Windows, `child_process` allocates a NEW CONSOLE for the child unless the call
// passes `windowsHide: true`; Windows 11 surfaces that console as a Windows Terminal window that
// flashes on the desktop and sometimes lingers showing `0x800700e8` ("the pipe is being closed") —
// the console being torn down as a short-lived child exits. It is not a fault in what the child
// does; it is the window the OS opened to run it in.
//
// THE PART THAT MADE IT A BUG RATHER THAN AN OVERSIGHT: hiding a parent does not hide its
// grandchildren. `lib/scheduler.js` set the option on the walker spawn, with a comment saying why,
// and the popups continued — because the walker's own `spawnSync(auto-ingest)` and auto-ingest's
// `execFileSync(ingest-transcript)` did not, and the Stop hook runs the latter on EVERY assistant
// response. Five connected clients are five servers, so the five-minute tick was five popups.
// An option set on 3 of 25 launch sites reads, from the desktop, exactly like an option nobody set.
//
// So the option does not belong at the call sites. It belongs HERE, once, and every call site goes
// through this module — which is a claim `(a97)` in the suite checks structurally, by grep, rather
// than a convention the next launch site is free to forget.
//
// WHAT THIS MODULE DOES NOT DO. It merges one key into `opts` and passes everything else through
// byte-for-byte: `stdio`, `env`, `cwd`, `detached`, `timeout`, `maxBuffer`, `encoding`, `shell`,
// `input`, all of it. It does not default `detached`, does not touch `stdio`, does not wrap the
// return value and does not catch anything — a caller that reads `r.status`, unrefs the child, or
// relies on the recall-stress harness's kill-tree semantics sees precisely what `child_process`
// gave it. An explicit `windowsHide: false` in `opts` still wins, because a caller that means it
// (a debugging session that wants the console) must be able to say so.
//
// `windowsHide` IS A NO-OP ON macOS AND LINUX — POSIX has no console to allocate — so this is not
// a platform branch and there is nothing to test differently per platform. The behaviour on the
// author's Mac is byte-identical before and after; the proof of the fix is a Windows desktop with
// no windows on it.

import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process';

/** `{ windowsHide: true, ...opts }` — the caller's own value, if it set one, wins. */
export function hidden(opts = {}) {
  return { windowsHide: true, ...opts };
}

/** `child_process.spawn` with no console window. Returns the ChildProcess, unchanged. */
export function spawnHidden(cmd, args = [], opts = {}) {
  return spawn(cmd, args, hidden(opts));
}

/** `child_process.spawnSync` with no console window. Returns the result object, unchanged. */
export function spawnSyncHidden(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, hidden(opts));
}

/**
 * `child_process.execFile` with no console window.
 *
 * The callback is optional and positional in the original, so both `(bin, args, cb)` and
 * `(bin, args, opts, cb)` have to keep working — including `promisify(execFileHidden)`, which
 * appends the callback itself and is how lib/git-join.js and lib/probes.js call git.
 */
export function execFileHidden(bin, args = [], opts, cb) {
  if (typeof opts === 'function') return execFile(bin, args, hidden({}), opts);
  return cb === undefined ? execFile(bin, args, hidden(opts)) : execFile(bin, args, hidden(opts), cb);
}
// promisify(execFileHidden) must yield `{stdout, stderr}` like promisify(execFile) does, not just
// stdout. execFile carries a custom promisify hook for that; a plain wrapper loses it, and
// git-join.js destructures `{ stdout }` off the result.
execFileHidden[Symbol.for('nodejs.util.promisify.custom')] =
  (bin, args, opts) => new Promise((res, rej) => {
    execFile(bin, args, hidden(opts), (err, stdout, stderr) =>
      err ? rej(Object.assign(err, { stdout, stderr })) : res({ stdout, stderr }));
  });

/** `child_process.execFileSync` with no console window. Returns stdout, unchanged. */
export function execFileSyncHidden(bin, args = [], opts = {}) {
  return execFileSync(bin, args, hidden(opts));
}
