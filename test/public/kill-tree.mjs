// test/public/kill-tree.mjs — kill a spawned writer AND everything it spawned, on any platform.
//
// 🟥 THE BUG THIS FIXES, and it made the Windows leg of two harnesses meaningless rather than red.
// Both fault harnesses kill a capture run from outside, deliberately, to see what the reader says
// about the gap. Both did it the POSIX way:
//
//     spawn(..., { detached: true })          // the child leads its own process group
//     process.kill(-child.pid, 'SIGKILL')     // negative pid = kill the whole group
//
// Neither half of that exists on Windows. There are no process groups in the POSIX sense, a
// negative pid is not a group id, and `process.kill(-1234, ...)` throws EINVAL/ESRCH — so the kill
// silently never happened. Worse, `detached: true` on Windows means "give this child its own
// CONSOLE", which is not isolation at all. The harnesses would then have observed a run that
// completed normally and reported it as a fault that did not arm.
//
// The Windows equivalent of "kill the group" is `taskkill /T`, which walks the child's own process
// tree — and it matters here specifically because what is being killed is not one process: the
// walker spawns auto-ingest, which spawns ingest-transcript. Killing only the parent would leave
// the extractor writing files into the store after the test believed it was dead.
//
// A helper rather than two copies, because a fault-injection kill that is subtly wrong on one
// platform is invisible: it does not fail, it just stops being a fault.

// 🟥 AND THE PROOF HAS TO BE PLATFORM-SHAPED TOO (MEM-63, 2026-09-05). Fixing the KILLER left the
// VERIFIER POSIX-only, which cost exactly as much: `verifyFault` asked for `signal === 'SIGKILL'`,
// Windows has no signals, `taskkill /T /F` leaves `{code: 1, signal: null}`, and six crash-recovery
// scenarios reported UNARMED on windows-latest for four CI runs in a row while all 18 passed. The
// kill worked every time — `ci-helpers/kill-tree-probe.mjs` measured the grandchild's heartbeat
// freezing 63 ms after it. So this file now hands back the EVIDENCE, not just a boolean: which pids
// were terminated, and whether they are all really gone afterwards. `signal` was never the fact
// worth checking; "the harness issued a kill and the tree it named is gone" is.

import { spawnSync } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * `detached` for spawn(), decided by platform.
 *
 * POSIX: true, so the child leads a process group and killTree can take the whole group.
 * Windows: FALSE — detached there opens a console window and buys nothing, because taskkill /T
 * finds the descendants from the pid regardless.
 */
export const detachedForPlatform = () => !IS_WINDOWS;

/**
 * Options every fault harness should spawn a writer with. Spread it into the spawn options.
 */
// 🟥 MEM-83: `windowsHide` UNCONDITIONALLY, not only on the Windows branch. It is a no-op on
// POSIX, and stating it once here is what lets the (a97) guard accept `...spawnOptsForKill()` as
// proof that a harness spawn is hidden — an allowance (a97) re-asserts against THIS line, so it
// cannot go stale by someone moving the option back inside the branch.
export const spawnOptsForKill = () => (IS_WINDOWS
  ? { detached: false, windowsHide: true }
  : { detached: true, windowsHide: true });

/**
 * Is this pid still running? `false` also for a pid we are not allowed to ask about, which is the
 * safe direction here: this only ever asks about processes this harness itself spawned.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WINDOWS) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true });
    // A tasklist that could not RUN proves nothing, and answering `false` there would let a
    // verifier read "I cannot see it" as "it is dead" — fail closed instead, so the harness says
    // the pid outlived the kill and somebody reads the reason.
    if (r.error) return true;
    // tasklist exits 0 with "INFO: No tasks are running..." on stdout when nothing matches, so the
    // exit code says nothing; the pid appearing in a CSV row is the answer.
    return new RegExp(`","${pid}","`).test(String(r.stdout));
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Every pid in `pids` is gone, waited for up to `timeoutMs`. Returns the survivors so a caller can
 * say WHICH process outlived the kill rather than only that one did.
 *
 * 🟥 ON POSIX THIS IS NOT A PROOF OF DEATH, and no caller should treat it as one. A SIGKILLed
 * child stays a ZOMBIE until its parent reaps it, and `process.kill(pid, 0)` succeeds on a zombie
 * — so `gone` is routinely false a millisecond after a kill that worked perfectly (measured: the
 * kill-tree probe on darwin reports killed:true, gone:false, signal SIGKILL). POSIX has `signal`,
 * which is the real proof there. This function exists for Windows, which has nothing else.
 */
export function treeGone(pids, { timeoutMs = 3000 } = {}) {
  const want = [...new Set((pids || []).filter((p) => Number.isInteger(p) && p > 0))];
  if (!want.length) return { gone: false, survivors: [], checked: 0, why: 'no pids to check' };
  const deadline = Date.now() + timeoutMs;
  let survivors = want;
  for (;;) {
    survivors = survivors.filter((p) => pidAlive(p));
    if (!survivors.length) return { gone: true, survivors: [], checked: want.length };
    if (Date.now() >= deadline) return { gone: false, survivors, checked: want.length };
    napSync(100);   // each poll SPAWNS tasklist; a tight loop would be hundreds of processes
  }
}

/**
 * Sleep without an event loop. Everything on this path is synchronous by necessity — the marker
 * has to be taken at the instant of the kill, and the F3/F4 watchers are busy loops that own the
 * loop anyway — so `await` is not available and a spin would burn the CPU the writer needs.
 */
function napSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = Date.now() + ms; while (Date.now() < t) { /* no SharedArrayBuffer: spin */ } }
}

/**
 * Kill `child` and every process it started.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {{killed:boolean, how:string, pids:number[]}} — `killed:false` when the process was
 *          already gone, which is a legitimate outcome (it finished before the watcher saw its
 *          landing site). `pids` is every process the kill CLAIMS to have ended, which is what
 *          `treeGone` is then asked about.
 */
/**
 * Which pids did `taskkill /T /F` actually END? Parsed from its stdout, which is the only
 * enumeration of the tree anyone gets:
 *
 *     SUCCESS: The process with PID 4884 (child process of PID 6512) has been terminated.
 *     SUCCESS: The process with PID 6512 has been terminated.
 *
 * 🟥 ONE PID PER LINE, THE FIRST ONE. Each line can name TWO pids and only the first died: the
 * parenthesised one is the PARENT, and for the root of the tree that parent is the HARNESS ITSELF.
 * A `/PID (\d+)/g` over the whole output therefore puts our own live pid in the casualty list,
 * `treeGone` finds it running, and every fault reports "a pid outlived the kill" — the same class
 * of mistake as MEM-63 one turn further on, with the failure moved from the signal clause to the
 * pid list. `with PID` anchors it to the killed one.
 *
 * A PURE FUNCTION, and separated from killTree for exactly one reason: the only machine that can
 * produce this string is a Windows one, and MEM-63 is the story of a Windows-only rule that nobody
 * could run anywhere else going wrong unnoticed. test/run-tests.js (a89) feeds it the RECORDED
 * output from a windows-latest runner, on whatever platform the suite is on.
 *
 * @param {string} stdout        taskkill's stdout
 * @param {number} fallbackPid   used when the output named nobody (localised Windows, /Q, a
 *                               redirected stream) — the parent is the one pid we always know
 * @returns {number[]} the terminated pids, de-duplicated, in the order taskkill reported them
 */
export function parseTaskkillPids(stdout, fallbackPid) {
  const pids = String(stdout == null ? '' : stdout).split(/\r?\n/)
    .map((line) => /with PID (\d+)/.exec(line))
    .filter(Boolean).map((m) => Number(m[1]))
    .filter((p, i, a) => a.indexOf(p) === i);
  return pids.length ? pids : (Number.isInteger(fallbackPid) && fallbackPid > 0 ? [fallbackPid] : []);
}

export function killTree(child) {
  const pid = child && child.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { killed: false, how: 'no pid', pids: [] };
  if (IS_WINDOWS) {
    // /T the tree, /F force. Exit code 128 means "process not found", which is not a failure here.
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) {
      return { killed: true, how: 'taskkill /T /F', pids: parseTaskkillPids(r.stdout, pid) };
    }
    // Last resort: at least take the parent, so a harness never hangs waiting on a live child.
    try { child.kill('SIGKILL'); return { killed: true, how: 'taskkill failed; child.kill', pids: [pid] }; }
    catch { return { killed: false, how: `taskkill status ${r.status}`, pids: [] }; }
  }
  let killed = false;
  try { process.kill(-pid, 'SIGKILL'); killed = true; } catch { /* group already gone */ }
  try { child.kill('SIGKILL'); killed = true; } catch { /* already gone */ }
  // The group leader is the only member POSIX names for us; the group id IS the leader's pid, and
  // the SIGKILL went to the whole group.
  return { killed, how: 'SIGKILL process group', pids: killed ? [pid] : [] };
}

/**
 * Kill the tree AND record what was killed, as the marker a verifier reads instead of `signal`.
 *
 * Everything a fault verifier needs and nothing it has to infer: the landing site the watcher
 * fired at, whether the kill was issued at all, which pids it claims it ended, and whether those
 * pids are gone a moment later. On Windows this REPLACES the signal check; on POSIX it sits
 * alongside one, because a SIGKILLed process still reports `signal: 'SIGKILL'` there and that
 * remains the cheapest possible proof.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} site   the landing site the watcher believes it fired at (F1..F4, 'timeout')
 */
export function killTreeMarked(child, site, { timeoutMs = 3000 } = {}) {
  const at = Date.now();
  const k = killTree(child);
  const g = k.killed ? treeGone(k.pids, { timeoutMs }) : { gone: false, survivors: [], checked: 0, why: 'no kill was issued' };
  return { site, at, killed: k.killed, how: k.how, pids: k.pids, gone: g.gone, survivors: g.survivors, platform: process.platform };
}
