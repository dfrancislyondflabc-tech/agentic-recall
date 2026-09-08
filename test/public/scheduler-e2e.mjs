// test/public/scheduler-e2e.mjs — DOES A LOADED SERVER ACTUALLY CAPTURE ANYTHING?
//
// Every other check in this project tests a part: the decision (run-tests.js (a79)), the walker's
// selection (a74), the writer's lock, the extractor's output. This one tests the CLAIM — that
// switching the connector on is now sufficient for a conversation to be remembered, with no
// LaunchAgent, no plist, no hook, and nothing else installed.
//
// 🟥 WHY IT IS IN THE PUBLIC SUITE AND NOT THE PRIVATE ONE. This is the check that has to run on
// windows-latest, because Windows is the platform the claim is FOR. There was never a Windows
// timer: the plist is macOS-only, so the 5-minute walk — and with it every sleep/wake and
// long-session gap it closes — simply did not exist there. A feature whose entire point is
// Windows, proved only on the author's Mac, is not proved.
//
// WHAT IS REAL HERE, and it is nearly all of it: a real `node index.js` MCP server driven over
// stdio JSON-RPC exactly as a client drives it (initialize, then tools/call, so the process is a
// genuine server and not a library import); the real scheduler; the real walker it spawns; the real
// extractor and the real index build. Only three things are fixtures — the transcript, the corpus,
// and the clock knobs (a 2-second interval instead of 300, so the test takes seconds).
//
// WHAT IT REFUSES TO ACCEPT AS A PASS. A run where the store gained a file but nothing says the
// SERVER caused it: hence the stamp's `source: 'server'`, the run-log line, and — the control that
// makes all of it evidence — a second run with MEMORY_SCHEDULER=0 in which the identical fixture
// must produce NOTHING.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnOptsForKill } from './kill-tree.mjs';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(dirname(HERE));                       // repo root, derived — never written down
const FIXTURES = join(TREE, 'test', 'fixtures', 'gold-corpus');

// 8 leading hex characters then a hyphen: the extractor refuses any other name shape.
const SID = 'd0d0cafe-1111-2222-3333-444455556666';
const TOKEN = 'schedtoken7781';                            // rare, and survives the query tokeniser

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mdFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')) : []);

/**
 * One complete exchange plus a later human turn.
 *
 * The later turn is what makes the exchange COMPLETE: the extractor pairs "one user turn and
 * everything the assistant said before the next user turn", and a timed walk passes --defer-last,
 * so the exchange with no following user turn is deliberately left for the next pass. Without the
 * third line this fixture would capture nothing and the test would fail for a reason that has
 * nothing to do with the scheduler.
 *
 * The reply clears the extractor's 200-character floor several times over; the ask is plain prose
 * with no angle brackets, so isMachineTurn() does not read it as machinery.
 */
function writeTranscript(path) {
  const prose = (n) => Array.from({ length: n }, (_, i) =>
    `The wheel was trued and the spoke tension checked on pass ${i} before the hub was reassembled.`).join(' ');
  const lines = [
    { type: 'user', timestamp: '2026-09-05T06:00:00.000Z',
      message: { role: 'user', content: `Please write up what we settled about the freehub service and file it under ${TOKEN}. ${prose(2)}` } },
    { type: 'assistant', timestamp: '2026-09-05T06:00:04.000Z',
      message: { role: 'assistant', content: [{ type: 'text',
        text: `Settled for ${TOKEN}: the pawls take light oil and never the thick bearing grease. ${prose(9)}` }] } },
    { type: 'user', timestamp: '2026-09-05T06:05:00.000Z',
      message: { role: 'user', content: 'thanks, that is all for now' } }
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/** A real MCP client over the real server's stdio. Returns { rpc, notify, close, stderr }. */
function startServer(env) {
  const child = spawn(process.execPath, [join(TREE, 'index.js')],
    // 🟥 spawnOptsForKill: on POSIX this is `detached: true`, which makes the child a PROCESS
    // GROUP LEADER — and without that, killTree's `process.kill(-pid)` has no group to take and
    // falls back to killing the parent alone, leaving the walker/extractor grandchildren alive.
    // (On Windows it is `detached: false`: there `detached` opens a console window and buys
    // nothing, because taskkill /T walks the tree from the pid regardless.)
    { cwd: TREE, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...spawnOptsForKill() });
  let buf = '', errText = '', nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { errText += `\nNON-JSON ON STDOUT: ${line.slice(0, 160)}`; continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  child.stderr.on('data', (d) => { errText += d.toString(); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    rpc,
    child,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    stderr: () => errText,
    // MEM-69: killTree + an awaited exit, never a bare child.kill() — this server spawns the
    // scheduler's capture children, and on Windows their handles keep the sandbox undeletable.
    close: () => { try { child.stdin.end(); } catch { /* gone */ } return stopChild(child); }
  };
}

/**
 * One run of the fixture under a live server.
 *
 * @param {object} o
 * @param {string} o.dir        sandbox
 * @param {boolean} o.on        scheduler enabled (false = the control)
 * @param {number} o.waitMs     how long to keep the server alive
 * @returns observations, not verdicts — the caller does the asserting
 */
async function runOnce(opts) {
  const { on, waitMs, measurePeriod = false } = opts;
  const { env, store, stamp, runLog, stagingIdx } = sandboxEnv(opts);
  const t0 = Date.now();
  const srv = startServer(env);
  return await observe({ srv, on, waitMs, measurePeriod, t0, store, stamp, runLog, stagingIdx });
}

/**
 * The sandbox and the environment, with no server started.
 *
 * Split out of runOnce() for the N-SERVER case: two servers sharing one sandbox is the shape the
 * churn fix is about, and the only difference from a single run is how many processes are pointed
 * at the same store, stamp and run log.
 */
function sandboxEnv({ dir, on, intervalSec = '2', tickMs = '500', jitterSec = '0' }) {
  const projects = join(dir, '.claude', 'projects', 'proj');
  const store = join(dir, 'store');
  const mem = join(dir, 'mem');
  mkdirSync(projects, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(mem, { recursive: true });
  for (const f of readdirSync(FIXTURES)) if (f.endsWith('.md')) writeFileSync(join(mem, f), readFileSync(join(FIXTURES, f)));
  writeTranscript(join(projects, `${SID}.jsonl`));

  // MEMORY_ROOT points at the sandbox, so the denylist resolves there too — and the extractor
  // FAILS CLOSED on a denylist it cannot read, which is correct and would otherwise turn this into
  // a test of the sandbox rather than of the scheduler. An empty fixture denylist, as
  // scripts/verify-stdio.js does it: the mechanism runs, and it depends on no machine's config.
  const secrets = join(dir, 'secrets-exclude.json');
  writeFileSync(secrets, JSON.stringify({
    _comment: 'fixture written by test/public/scheduler-e2e.mjs',
    excludeFiles: [], sectionScrub: {}, patterns: [], tokenHashesSha256: []
  }, null, 2) + '\n');

  const stamp = join(dir, 'timed-capture-last.json');
  const runLog = join(dir, 'ingest-runs.jsonl');
  const stagingIdx = join(dir, 'staging.json');

  const env = {
    ...process.env,
    // BOTH home variables: os.homedir() reads HOME on POSIX and USERPROFILE on Windows, and the
    // walker discovers ~/.claude/projects through homedir(). Setting only HOME sandboxes two
    // platforms out of three — which is exactly the class of thing this file exists to catch.
    HOME: dir,
    USERPROFILE: dir,
    // MEMORY_ROOT keeps every derived path (heartbeat, vector cache, local-config) inside the
    // sandbox. It does NOT move the CODE root — lib/scheduler.js resolves the walker from
    // import.meta.url — which is the whole reason those two roots are separate.
    MEMORY_ROOT: dir,
    MEMORY_DIR: mem,
    MEMORY_INDEX: join(dir, 'curated.json'),
    MEMORY_OWN_STORE: store,
    MEMORY_STAGING_INDEX: stagingIdx,
    MEMORY_HANDOFF_INDEX: '0',
    MEMORY_PROJECTS_INDEX: '0',
    MEMORY_LIBRARY: '0',
    MEMORY_ALL_PROJECTS: '0',
    MEMORY_AUTHOR_CORPUS: '0',
    MEMORY_GIT_REPOS: '',
    MEMORY_MODEL_CACHE: join(TREE, '.model-cache'),
    MEMORY_SECRETS_CONFIG: secrets,
    MEMORY_QUERY_LOG: join(dir, 'q.jsonl'),
    MEMORY_INGEST_LOG: runLog,
    MEMORY_TIMED_CAPTURE_STAMP: stamp,
    MEMORY_TIMED_CAPTURE_LOCK: join(dir, 'timed-capture.lock'),
    MEMORY_PENDING_INDEX: join(dir, 'pending-index.json'),
    MEMORY_RECONCILE_STAMP: join(dir, 'last-reconcile.json'),
    MEMORY_VANISH_LOG: join(dir, 'vanish.jsonl'),
    MEMORY_RECALL_CANARY: '0',
    MEMORY_QUERY_SOURCE: 'test',
    MEMORY_ACCOUNT: 'scheduler-e2e',
    // THE ONE FIXTURE IN THE PRODUCTION PATH: 'always' bypasses the heartbeat gate. auto-ingest
    // normally refuses to write unless connectorRecentlyOn() — the mark this very server leaves —
    // is fresh, which would work here, but making the test depend on a 60-second heartbeat timer
    // would be testing the clock instead of the scheduler.
    MEMORY_AUTO_INGEST: 'always',
    MEMORY_INGEST_DEBOUNCE_SEC: '0',
    // The walker THIS TREE ships, not whatever sha is frozen in a developer's dist/capture/.
    MEMORY_CAPTURE_SCRIPT: join(TREE, 'scripts', 'timed-capture.mjs'),
    MEMORY_SCHEDULER: on ? '1' : '0',
    MEMORY_SCHEDULER_INTERVAL_SEC: intervalSec,
    MEMORY_SCHEDULER_TICK_MS: tickMs,
    MEMORY_SCHEDULER_JITTER_SEC: jitterSec    // deterministic by default: jitter is (a79)/(a88)'s subject
  };

  return { env, store, mem, stamp, runLog, stagingIdx };
}

/** Drive one live server over the window and report observations — never verdicts. */
async function observe({ srv, on, waitMs, measurePeriod, t0, store, stamp, runLog, stagingIdx }) {
  let handshake = null, latest = null, firstCaptureMs = null;
  try {
    handshake = await srv.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'scheduler-e2e', version: '1.0.0' }
    });
    srv.notify('notifications/initialized', {});
    // One real call, so the process is a live MCP server for the whole window and not just a
    // node process that happens to have loaded index.js.
    await srv.rpc('tools/call', { name: 'memory', arguments: { action: 'search', query: 'light oil on the pawls', limit: 2 } });

    // Poll rather than sleep a flat 20 s: the assertions are the same, and the common case
    // finishes in a few seconds instead of always paying the worst case on three platforms.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (on && mdFiles(store).length > 0 && existsSync(stamp) && existsSync(stagingIdx)) {
        if (firstCaptureMs === null) firstCaptureMs = Date.now() - t0;
        // MEM-60: the period run holds the server up for the WHOLE window. Breaking at the first
        // capture is right for every other assertion here and useless for a period, which needs
        // several walks to have a gap between them at all.
        if (!measurePeriod) break;
      }
      await sleep(250);
    }

    // Asked through the SAME live server, so what is being tested is the answer a client gets --
    // including the in-process index reload that a long-lived server has to do to see a file its
    // own child just wrote.
    const r = await srv.rpc('tools/call', { name: 'memory', arguments: { action: 'latest', query: TOKEN, scope: 'staging', limit: 5 } });
    try { latest = JSON.parse(r.result.content[0].text); } catch { latest = { __unparsable: true }; }
  } finally {
    await srv.close();
  }

  const rows = existsSync(runLog) ? readFileSync(runLog, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  let header = null;
  try { ({ indexHeaderOnDisk: header } = await import('../../lib/index-store.js')); } catch { /* reported below */ }
  return {
    ms: Date.now() - t0,
    firstCaptureMs,
    serverName: handshake?.result?.serverInfo?.name || null,
    store: mdFiles(store),
    stamp: existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : null,
    walkerRows: rows.filter((r) => r.trigger === 'walker'),
    ingestRows: rows.filter((r) => r.trigger !== 'walker'),
    indexDocs: header && existsSync(stagingIdx) ? (header(stagingIdx)?.docCount ?? null) : null,
    latest,
    stderrTail: srv.stderr().split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400)
  };
}

const rowsOf = (b) => [...(Array.isArray(b?.results) ? b.results : []),
  ...((Array.isArray(b?.sections) ? b.sections : []).flatMap((s) => (Array.isArray(s.results) ? s.results : [])))];

/**
 * @param {object} o
 * @param {(name:string, ok:boolean, detail?:string)=>void} o.check
 * @param {(t:string)=>void} o.group
 */
export async function schedulerE2E({ check, group }) {
  group('a loaded server keeps time — capture with no LaunchAgent, no plist and no hook');

  const dir = mkdtempSync(join(tmpdir(), 'sched-e2e-'));
  try {
    // 40 s is a CEILING, not a wait: the loop inside exits as soon as the store, the stamp and the
    // index all exist, which is ~1.7 s locally. The headroom is for a CI runner that has to embed a
    // fresh model on a cold cache, and Windows runners are the slowest of the three.
    const on = await runOnce({ dir: join(dir, 'on'), on: true, waitMs: 40_000 });
    console.log(`  info  scheduler ON: ${on.ms} ms total, first capture at ${on.firstCaptureMs ?? 'never'} ms, ` +
      `${on.store.length} store file(s), index docCount ${on.indexDocs}`);
    if (!on.store.length) console.log(`  info  server stderr: ${on.stderrTail}`);

    check('the real MCP server answered the handshake', on.serverName === 'agentic-recall', String(on.serverName));
    check('an exchange reached the store with nothing installed but the server itself',
      on.store.length === 1 && /^x-d0d0cafe-/.test(on.store[0]), JSON.stringify(on.store));
    check('...and the SERVER is what caused it: the walk is stamped source:"server"',
      on.stamp?.source === 'server' && typeof on.stamp?.at === 'string', JSON.stringify(on.stamp));
    check('...and the run log carries the walk, so an invisible background writer is diagnosable',
      on.walkerRows.some((r) => r.outcome === 'started' && r.source === 'server'),
      JSON.stringify(on.walkerRows.slice(0, 4)));
    check('...and the per-session writer really ran under it (trigger:"timed", not a hook)',
      on.ingestRows.some((r) => r.trigger === 'timed'), JSON.stringify(on.ingestRows.map((r) => [r.trigger, r.outcome]).slice(0, 6)));
    check('the staging index was rebuilt, so the exchange is retrievable and not merely present',
      Number.isFinite(on.indexDocs) && on.indexDocs >= 1, String(on.indexDocs));
    check('and a client asking `latest` through the same live server gets the exchange back',
      rowsOf(on.latest).some((r) => /^x-d0d0cafe-/.test(String(r?.name))),
      JSON.stringify({ rows: rowsOf(on.latest).length, names: rowsOf(on.latest).map((r) => r?.name).slice(0, 3),
        note: String(on.latest?.note || on.latest?.error || '').slice(0, 120) }));

    // ---- THE CONTROL. Without it, every check above could be passing because of a hook, a stray
    // LaunchAgent on the developer's machine, or an ingest triggered by something else entirely.
    const off = await runOnce({ dir: join(dir, 'off'), on: false, waitMs: 12_000 });
    console.log(`  info  scheduler OFF: ${off.ms} ms, ${off.store.length} store file(s), ${off.walkerRows.length} walker row(s)`);
    check('CONTROL — MEMORY_SCHEDULER=0 and the identical fixture is captured by nobody',
      off.store.length === 0 && off.walkerRows.length === 0 && off.stamp === null,
      JSON.stringify({ store: off.store, walker: off.walkerRows.length, stamp: off.stamp }));
    check('CONTROL — ...and the server is otherwise perfectly healthy: it still answers',
      off.serverName === 'agentic-recall' && !!off.latest, String(off.serverName));

    // ---- MEM-60: IS THE PERIOD THE INTERVAL? --------------------------------------------------
    //
    // 🟥 THE ONE THING THIS FILE COULD NOT SEE. Campaign A measured a walk every 360.0 s against a
    // configured 300 s — 19 of 19 gaps across two hour-long runs, and the server's own log said
    // `last walk 360s ago, due at 300s` ten times. The runs above cannot catch it: they set an
    // interval of 2 s on a 500 ms tick, and an interval that is NOT tripped up by its own tick grid
    // is precisely the case that hides the defect. So this one runs on a grid with the same shape as
    // production — the interval an exact multiple of the tick — and measures the PERIOD IN SECONDS
    // rather than asserting that a walk happened at all.
    //
    // 10 s interval on a 2 s tick over 44 s: the first tick fires at 2 s (nothing has ever walked),
    // then a walk every 10 s. The FIRST gap is excluded on purpose — that walk carries the capture,
    // the extractor and the whole index build, and a walker holds the lock for its own duration, so
    // its length is a statement about a cold model cache on a CI runner and not about the clock.
    // Every later walk finds nothing uncaptured and costs a spawn and a listing compare.
    const per = await runOnce({ dir: join(dir, 'period'), on: true, waitMs: 44_000,
      intervalSec: '10', tickMs: '2000', measurePeriod: true });
    const starts = per.walkerRows.filter((r) => r.outcome === 'started')
      .map((r) => Date.parse(r.at)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = starts.slice(1).map((t, i) => Math.round((t - starts[i]) / 100) / 10);
    const measured = gaps.slice(1);                       // drop the capture+index walk's gap
    console.log(`  info  MEM-60 period run: ${starts.length} walk(s) in ${per.ms} ms, ` +
      `gaps ${JSON.stringify(gaps)} s (asserting on ${JSON.stringify(measured)}), ` +
      `${per.walkerRows.filter((r) => r.outcome === 'finished').length} finished`);

    check('MEM-60: a 10s interval walks about every 10s — enough walks in 44s to have a period at all',
      starts.length >= 3, JSON.stringify({ starts: starts.length, gaps }));
    check('MEM-60: ...and the measured period is 10s ± 1s, NOT the interval plus a whole tick',
      measured.length >= 1 && measured.every((g) => g >= 9 && g <= 11),
      JSON.stringify({ measured, bar: '9..11 s', wouldHaveBeen: '12 s before the fix' }));
    check('MEM-60: ...and no gap reaches interval + tick (12s), which is what the defect produced',
      measured.every((g) => g < 12), JSON.stringify(measured));
    check('MEM-60: ...and the walks really ran — every start but at most the last one finished',
      per.walkerRows.filter((r) => r.outcome === 'finished').length >= starts.length - 1,
      JSON.stringify(per.walkerRows.map((r) => r.outcome)));

    // ---- MEM-83 (the churn half): TWO SERVERS, ONE MACHINE ------------------------------------
    //
    // 🟥 THE MULTIPLIER. Every connected Claude client gets its own server process with its own
    // scheduler; the Windows tester was running five. Five walkers per tick is five process spawns,
    // five index loads' worth of page cache and — before lib/child.js — five console windows, of
    // which four exist only to discover the lock is held and exit 0. The lock makes that safe. It
    // does not make it free.
    //
    // WHAT THIS MEASURES, and it is the outcome rather than the mechanism: `started` rows in the
    // shared run log. Only the lock WINNER writes `started` (scripts/timed-capture.mjs:173); a
    // loser writes `skipped / walker lock held`, so the two counts separate "walks that ran" from
    // "children spawned for nothing" exactly. The property asserted is one walk per interval and
    // no lock-losers at all, with both servers pointed at one store, one stamp and one run log.
    //
    // The second look in lib/scheduler.js is decided by shouldSkipRecentWalk(), whose boundaries
    // are a truth table in the private suite ((a97)) — an e2e cannot land a neighbour's stamp
    // inside the sub-tick window between one server's decision and its spawn on demand, so this
    // asserts the outcome and (a97) asserts the decision.
    {
      const two = join(dir, 'two');
      const INTERVAL = 4;
      const { env, store: twoStore, runLog: twoLog } = sandboxEnv({ dir: two, on: true,
        intervalSec: String(INTERVAL), tickMs: '500' });
      const a = startServer(env);
      const hello = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sched-a', version: '1' } };
      await a.rpc('initialize', hello); a.notify('notifications/initialized', {});
      // A REAL STAGGER, because that is what happens: Claude starts the servers one after another
      // and each spends seconds loading an index, so their tick grids are seconds apart.
      await sleep(1200);
      const b = startServer(env);
      await b.rpc('initialize', { ...hello, clientInfo: { name: 'sched-b', version: '1' } });
      b.notify('notifications/initialized', {});
      const WINDOW_MS = INTERVAL * 1000 * 3 + 4_000;      // room for three due points
      let aErr = '', bErr = '';
      try {
        await sleep(WINDOW_MS);
      } finally {
        aErr = a.stderr(); bErr = b.stderr();
        await a.close(); await b.close();
      }
      const rows = existsSync(twoLog) ? readFileSync(twoLog, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
      const walker = rows.filter((r) => r.trigger === 'walker');
      const started = walker.filter((r) => r.outcome === 'started')
        .map((r) => Date.parse(r.at)).filter(Number.isFinite).sort((x, y) => x - y);
      const lockLosers = walker.filter((r) => r.outcome === 'skipped' && /lock held/.test(String(r.why || '')));
      const gaps = started.slice(1).map((t, i) => Math.round((t - started[i]) / 100) / 10);
      const skipLines = (aErr + bErr).split('\n').filter((l) => /capture walk skipped/.test(l)).length;
      console.log(`  info  two servers, ${INTERVAL}s interval over ${WINDOW_MS} ms: ` +
        `${started.length} walk(s) started, gaps ${JSON.stringify(gaps)} s, ` +
        `${lockLosers.length} lock-loser(s), ${skipLines} "walk skipped" line(s), ` +
        `${twoStore ? mdFiles(twoStore).length : 0} store file(s)`);

      check('MEM-83: two servers on one machine still CAPTURE — the churn fix did not stop the walk',
        started.length >= 2 && mdFiles(twoStore).length === 1,
        JSON.stringify({ started: started.length, store: mdFiles(twoStore) }));
      check('MEM-83: ...and one walk RUNS per interval — no two starts inside half an interval',
        gaps.every((g) => g >= INTERVAL / 2), JSON.stringify({ gaps, floor: INTERVAL / 2 }));
      check('MEM-83: ...and the walk count is one per interval, not one per server per interval',
        started.length <= Math.ceil(WINDOW_MS / 1000 / INTERVAL) + 1,
        JSON.stringify({ started: started.length, ceiling: Math.ceil(WINDOW_MS / 1000 / INTERVAL) + 1 }));
      // 🟥 NOT ASSERTED, AND THE MEASUREMENT SAYS WHY. The lock-loser count is the churn, and the
      // fix REDUCES it rather than removing it: measured on this Mac over three reps at a 4 s
      // interval, five servers went from 10 lock-losers / 19 walks to 4 / 18, and two servers sit
      // at 0 either way depending on where their 500 ms tick grids happen to land. What remains is
      // servers whose ticks fall in the same few milliseconds, which only the parent holding the
      // lock for its child's whole run could stop. So the number is PRINTED — a regression shows
      // up in the info line — and the assertion above is on the property that is deterministic:
      // one walk RUNS per interval. The claim itself is asserted deterministically in (a97).
      check('MEM-83: ...and every child that started a walk also finished it — no half-walks',
        walker.filter((r) => r.outcome === 'finished').length >= started.length - 1,
        JSON.stringify(walker.map((r) => r.outcome)));
      check('MEM-83: [control] both servers really were alive and scheduling for the whole window',
        /capture scheduler ON/.test(aErr) && /capture scheduler ON/.test(bErr),
        JSON.stringify({ a: /capture scheduler ON/.test(aErr), b: /capture scheduler ON/.test(bErr) }));
    }
  } finally {
    cleanupSandbox(dir, { label: 'scheduler-e2e' });   // MEM-69: never fail the run over cleanup
  }
}
