// ci-helpers/kill-tree-probe.mjs — what does a parent OBSERVE after killTree, on this platform?
//
// WHY THIS EXISTS. The recall-stress harness proves a fault landed rather than believing its own
// watcher, and one clause of that proof USED TO BE `r.signal !== 'SIGKILL' && r.code !== null` →
// "exited N rather than by signal" (test/recall-stress/scheduler.mjs verifyFault). That clause was
// POSIX. Windows has no signals: `taskkill /T /F` ends the process and Node reports an exit CODE
// with `signal: null`, so the clause was false on every attempt whether or not the kill worked —
// and the harness reported UNARMED for a fault that landed perfectly. That is MEM-63, and this
// probe is the measurement that proved it came from the READER and not the KILLER.
//
// IT STAYS AFTER THE FIX, and it now evaluates the CURRENT rule rather than a quotation of the old
// one, so it answers the next version of the same question: if arming ever regresses, is the kill
// broken or is the proof broken? The two are indistinguishable from the harness's own log.
//
// This probe separates the two questions the harness conflates:
//   1. did killTree actually kill the process AND its child?     (the thing that matters)
//   2. would the verifier accept what the parent saw?            (the thing verifyFault reads)
//
// 🟥 TWO WAYS THIS PROBE LIED BEFORE IT TOLD THE TRUTH, both recorded because a diagnostic that
// invents a finding is worse than no diagnostic:
//   * it compared the heartbeat taken JUST BEFORE the kill with one taken after. On POSIX the kill
//     is a syscall and lands inside the 50 ms tick; on Windows `taskkill` is a whole process and
//     takes ~100 ms, in which the grandchild writes once more. It was measuring taskkill's latency
//     and reporting it as survival. Now BOTH samples are taken after the dust settles.
//   * it embedded the heartbeat path in a nested template literal, so a Windows path's backslashes
//     were unescaped twice and the grandchild died at parse time — every heartbeat null, which the
//     old survival test read as "still writing". The path goes through the environment now, and a
//     grandchild that never started is reported as exactly that.
//
// Diagnostic only: it exits 0 whatever it finds. A diagnostic that fails the build stops being read.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTreeMarked, spawnOptsForKill, IS_WINDOWS } from '../test/public/kill-tree.mjs';

const dir = mkdtempSync(join(tmpdir(), 'killprobe-'));
const beat = join(dir, 'grandchild-heartbeat.txt');

// A GRANDCHILD, because what the harness kills is walker → auto-ingest → extractor: killing only
// the parent leaves the writer running into the store. Real files, and the path arrives through the
// environment — never interpolated into source, which is how the first version died on Windows.
const grandchildSrc = join(dir, 'grandchild.mjs');
writeFileSync(grandchildSrc,
  "import { writeFileSync } from 'node:fs';\n" +
  "setInterval(() => writeFileSync(process.env.PROBE_BEAT, String(Date.now())), 50);\n");
const childSrc = join(dir, 'child.mjs');
writeFileSync(childSrc,
  "import { spawn } from 'node:child_process';\n" +
  "spawn(process.execPath, [process.env.PROBE_GRANDCHILD], { stdio: 'ignore' });\n" +
  "setInterval(() => {}, 1000);\n");

const env = { ...process.env, PROBE_BEAT: beat, PROBE_GRANDCHILD: grandchildSrc };
const child = spawn(process.execPath, [childSrc], { env, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptsForKill() });
const closed = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));

const read = () => (existsSync(beat) ? readFileSync(beat, 'utf8') : null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(2500);                                  // the grandchild has to actually get going
const beatBeforeKill = read();
const how = killTreeMarked(child, 'probe');
const observed = await closed;

// BOTH samples after the kill, a second and a half apart: survival, not latency.
await wait(1500);
const settled = read();
await wait(1500);
const later = read();

const started = beatBeforeKill !== null;
const grandchildDead = started && later === settled;
// The CURRENT rule, in the same shape verifyFault uses it: on Windows the marker is the proof,
// on POSIX the signal is, and each accepts the other's evidence. Kept as a copy on purpose —
// importing the private harness would make this helper unrunnable from a release tree, which is
// the one place a recipient might want to ask what their platform does.
const verifyFaultWouldAccept = IS_WINDOWS
  ? !!(how.killed && how.gone && observed.code !== 0)
  : observed.signal === 'SIGKILL' || !!(how.killed && observed.code !== 0);

const verdict = !started
  ? 'INCONCLUSIVE — the grandchild never wrote a heartbeat, so nothing was proved about the kill'
  : grandchildDead && !verifyFaultWouldAccept
    ? 'THE KILL WORKS AND THE VERIFIER REJECTS IT — the proof has drifted from the platform again (MEM-63)'
    : grandchildDead ? 'the kill works and the verifier accepts it'
      : verifyFaultWouldAccept
        ? 'THE VERIFIER ACCEPTS A KILL THAT DID NOT REACH THE GRANDCHILD — the proof is too weak'
        : 'THE KILL DID NOT REACH THE GRANDCHILD';

console.log(JSON.stringify({
  platform: process.platform, isWindows: IS_WINDOWS, killTree: how, observed,
  grandchildStarted: started, grandchildStillWriting: started && !grandchildDead,
  heartbeats: { beforeKill: beatBeforeKill, settled, oneSecondLater: later },
  verifyFaultWouldAccept, verdict
}, null, 2));
process.exit(0);
