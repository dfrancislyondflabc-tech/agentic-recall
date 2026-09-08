// test/public/inflight-quiet-capture-e2e.mjs — MEM-67: the LAST exchange of a hook-less install.
//
// 🟥 THE CLAIM UNDER TEST, and it is the Windows promise in one sentence: switch the connector on
// and the conversation is remembered — no Stop hook, no LaunchAgent, no plist. Every part of that
// was true in 1.7.1 except the part a reader notices first: the exchange being written RIGHT NOW.
//
// A timed walk passed `--defer-last`, so the in-flight exchange — the one with no later human turn
// — was deferred on every tick. The Stop hook is the only capture path that never defers, and on
// the machine this promise is FOR, the hook is not installed. So the newest exchange of a chat
// reached the store only when the hourly store audit (grace 15 min) healed it. Measured on the
// Windows PC on 2026-09-05: ~14 minutes for a token the acceptance test gives 60 seconds, ~75
// minutes worst case. The tester did everything right and the product told the truth throughout —
// `uncapturedSessions` named the session on every query — it simply took an hour.
//
// The cure is a distinction the flag could not make: a transcript still MOVING is a turn being
// written, and a transcript that has not moved for MEMORY_INFLIGHT_QUIET_MIN (10) minutes is a turn
// that is over or abandoned. Only the first is worth deferring.
//
// WHAT IS REAL HERE: a real `node index.js` MCP server driven over stdio the way a client drives
// it, its real in-process scheduler, the real walker it spawns, the real auto-ingest, the real
// extractor, the real index build, and a real `latest` query at the end. The fixtures are the
// transcript, the corpus, the scheduler interval (2 s instead of 300) and the transcript's mtime —
// which is the input the whole rule is about, so a harness that could not set it could not test it.
//
// WHY IT IS PUBLIC: this is a Windows-shaped defect (no hooks there, and hooks are what hid it on
// the author's Mac), so the check has to run on windows-latest. A fix proved only where the defect
// could not appear is not proved.
//
// WHAT IT REFUSES TO ACCEPT AS A PASS: a run where the store gained the token but a LIVE turn's
// half-written reply was written too. The control run uses the same fixture with a FRESH mtime and
// must capture the completed exchange and NOT the in-flight one — otherwise this "fix" is just the
// old MEM-18 defect (a partial answer searchable as though it were finished) wearing a new flag.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { killTree, spawnOptsForKill } from './kill-tree.mjs';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(dirname(HERE));                       // repo root, derived — never written down
const FIXTURES = join(TREE, 'test', 'fixtures', 'gold-corpus');

// 8 leading hex characters then a hyphen: the extractor refuses any other name shape.
const SID = 'beadfeed-1111-2222-3333-444455556666';
const DONE_TOKEN = 'quietdone4417';                        // in the COMPLETED exchange
const LIVE_TOKEN = 'quietlive9264';                        // in the IN-FLIGHT exchange

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mdFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')) : []);
const storeText = (d) => mdFiles(d).map((f) => readFileSync(join(d, f), 'utf8')).join('\n');

/**
 * Two exchanges. The first is COMPLETE — a later human turn follows its reply. The second has no
 * later human turn at all, which is exactly what "in flight" means to the extractor, and is the
 * shape of every chat that is still open or was abandoned mid-answer.
 */
function writeTranscript(path) {
  const prose = (n) => Array.from({ length: n }, (_, i) =>
    `The rim was trued and the spoke tension checked on pass ${i} before the hub went back together.`).join(' ');
  const lines = [
    { type: 'user', timestamp: '2026-09-05T06:00:00.000Z',
      message: { role: 'user', content: `What did we settle about the freehub service? File it under ${DONE_TOKEN}. ${prose(2)}` } },
    { type: 'assistant', timestamp: '2026-09-05T06:00:04.000Z',
      message: { role: 'assistant', content: [{ type: 'text',
        text: `Settled for ${DONE_TOKEN}: the pawls take light oil and never the thick bearing grease. ${prose(9)}` }] } },
    { type: 'user', timestamp: '2026-09-05T06:05:00.000Z',
      message: { role: 'user', content: `And the pawl spring measurement — record it as ${LIVE_TOKEN}. ${prose(2)}` } },
    { type: 'assistant', timestamp: '2026-09-05T06:05:06.000Z',
      message: { role: 'assistant', content: [{ type: 'text',
        text: `For ${LIVE_TOKEN} the pawl spring measures 0.4 mm of free travel at the seat. ${prose(9)}` }] } }
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

/** A real MCP client over the real server's stdio. */
function startServer(env) {
  const child = spawn(process.execPath, [join(TREE, 'index.js')],
    { cwd: TREE, env, stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptsForKill() });
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
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: p }) + '\n'),
    stderr: () => errText,
    // 🟥 killTree, not child.kill(): the server spawns the walker, which spawns auto-ingest, which
    // spawns the extractor. Killing only the parent leaves an extractor writing into a store this
    // harness is about to delete — an EBUSY on Windows (MEM-69) and a phantom file on POSIX.
    close: () => { try { child.stdin.end(); } catch { /* gone */ } return stopChild(child); }   // killTree + awaited exit (MEM-69)
  };
}

/**
 * One run of the fixture under a live server.
 *
 * @param {object} o
 * @param {string} o.dir        sandbox
 * @param {number} o.quietMin   how long ago the transcript last moved (the whole subject)
 * @param {number} o.waitMs     how long to keep the server alive
 * @param {string} o.waitFor    stop early as soon as this token is in the store
 * @returns observations, not verdicts — the caller does the asserting
 */
async function runOnce({ dir, quietMin, waitMs, waitFor }) {
  const projects = join(dir, '.claude', 'projects', 'proj');
  const store = join(dir, 'store');
  const mem = join(dir, 'mem');
  mkdirSync(projects, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(mem, { recursive: true });
  for (const f of readdirSync(FIXTURES)) if (f.endsWith('.md')) writeFileSync(join(mem, f), readFileSync(join(FIXTURES, f)));
  const tx = writeTranscript(join(projects, `${SID}.jsonl`));
  // THE INPUT UNDER TEST. Node writes mtime in seconds-with-fraction; both stamps are set so no
  // reader can pick the one that was not moved.
  const when = (Date.now() - quietMin * 60_000) / 1000;
  utimesSync(tx, when, when);

  // An empty fixture denylist, as scripts/verify-stdio.js does it: the extractor FAILS CLOSED on a
  // denylist it cannot read, so without this the test would be measuring the sandbox.
  const secrets = join(dir, 'secrets-exclude.json');
  writeFileSync(secrets, JSON.stringify({
    _comment: 'fixture written by test/public/inflight-quiet-capture-e2e.mjs',
    excludeFiles: [], sectionScrub: {}, patterns: [], tokenHashesSha256: []
  }, null, 2) + '\n');

  const runLog = join(dir, 'ingest-runs.jsonl');
  const env = {
    ...process.env,
    HOME: dir, USERPROFILE: dir,          // homedir() reads one on POSIX and the other on Windows
    MEMORY_ROOT: dir,
    MEMORY_DIR: mem,
    MEMORY_INDEX: join(dir, 'curated.json'),
    MEMORY_OWN_STORE: store,
    MEMORY_STAGING_INDEX: join(dir, 'staging.json'),
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
    MEMORY_TIMED_CAPTURE_STAMP: join(dir, 'timed-capture-last.json'),
    MEMORY_TIMED_CAPTURE_LOCK: join(dir, 'timed-capture.lock'),
    MEMORY_PENDING_INDEX: join(dir, 'pending-index.json'),
    MEMORY_RECONCILE_STAMP: join(dir, 'last-reconcile.json'),
    MEMORY_VANISH_LOG: join(dir, 'vanish.jsonl'),
    MEMORY_RECALL_CANARY: '0',
    MEMORY_QUERY_SOURCE: 'test',
    MEMORY_ACCOUNT: 'inflight-quiet-e2e',
    MEMORY_AUTO_INGEST: 'always',         // bypass the heartbeat gate, not the capture logic
    MEMORY_INGEST_DEBOUNCE_SEC: '0',
    MEMORY_CAPTURE_SCRIPT: join(TREE, 'scripts', 'timed-capture.mjs'),
    MEMORY_SCHEDULER: '1',
    MEMORY_SCHEDULER_INTERVAL_SEC: '2',
    MEMORY_SCHEDULER_TICK_MS: '500',
    MEMORY_SCHEDULER_JITTER_SEC: '0'
    // MEMORY_INFLIGHT_QUIET_MIN deliberately UNSET: the shipped default (10 min) is the thing a
    // fresh install gets, so it is the thing under test.
  };

  const t0 = Date.now();
  const srv = startServer(env);
  let capturedMs = null, latest = null;
  try {
    await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'inflight-quiet-e2e', version: '1.0.0' } });
    srv.notify('notifications/initialized', {});
    await srv.rpc('tools/call', { name: 'memory', arguments: { action: 'search', query: 'light oil on the pawls', limit: 2 } });

    const stampOf = () => { try { return JSON.parse(readFileSync(join(store, '.last-ingest.json'), 'utf8'))[tx] || null; } catch { return null; } };
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (waitFor && capturedMs === null && storeText(store).includes(waitFor)) capturedMs = Date.now() - t0;
      // 🟥 THE FILE LANDS BEFORE THE RUN ENDS. auto-ingest writes the store, THEN builds the index,
      // THEN stamps in its `finally` — so a harness that stopped at the token and killed the tree
      // would be reading a stamp from a run it interrupted, and calling that the product's answer.
      // Wait for the run to finish its own bookkeeping (measured: ~1.8 s for the token, the stamp a
      // moment later); capturedMs still records the first sighting.
      if (capturedMs !== null && stampOf()) break;
      await sleep(400);
    }
    // One real client read, through the same live server, so "in the store" is not mistaken for
    // "retrievable".
    const r = await srv.rpc('tools/call', { name: 'memory', arguments: { action: 'latest', scope: 'staging', limit: 5 } });
    try { latest = JSON.parse(r?.result?.content?.[0]?.text || '{}'); } catch { latest = null; }
  } finally {
    srv.close();
    await sleep(300);                      // let the tree actually go before anything is deleted
  }

  const text = storeText(store);
  let stamp = null;
  try { stamp = JSON.parse(readFileSync(join(store, '.last-ingest.json'), 'utf8'))[tx] || null; } catch { stamp = null; }
  const rows = existsSync(runLog)
    ? readFileSync(runLog, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  return { ms: Date.now() - t0, capturedMs, files: mdFiles(store), text, stamp, rows, latest,
    hasDone: text.includes(DONE_TOKEN), hasLive: text.includes(LIVE_TOKEN),
    inFlightStamped: /^\s*inFlight:\s*true\s*$/m.test(text), stderr: srv.stderr() };
}

export async function inflightQuietCaptureE2E({ check, group }) {
  group('MEM-67 — a live server captures the exchange of a QUIET turn, and still defers a live one');
  const dir = mkdtempSync(join(tmpdir(), 'quiet-e2e-'));
  try {
    // ---- THE FIX. A transcript that has not moved for 11 minutes -----------------------------
    // 25 s is a ceiling, not an expectation: the first walk carries the model load and the first
    // index build. Before the fix this run would never capture the live token at all — the walker
    // deferred it on every tick and, once the stamp said the whole file had been read, stopped
    // selecting the session entirely.
    const quiet = await runOnce({ dir: join(dir, 'quiet'), quietMin: 11, waitMs: 25_000, waitFor: LIVE_TOKEN });
    console.log(`  info  quiet 11 min: token in the store after ${quiet.capturedMs ?? 'NEVER'} ms ` +
      `(${quiet.files.length} file(s), run rows ${quiet.rows.map((r) => r.outcome).join(',') || 'none'})`);

    check('MEM-67: a turn quiet for 11 minutes has its final exchange captured by the TIMER alone — '
        + 'no Stop hook, no LaunchAgent',
      quiet.hasLive, JSON.stringify({ files: quiet.files, capturedMs: quiet.capturedMs,
        stderr: quiet.stderr.split('\n').filter((l) => /defer|quiet|summary/.test(l)).slice(-3) }));
    check('MEM-67: ...within one scheduler window, not one audit interval',
      Number.isFinite(quiet.capturedMs) && quiet.capturedMs < 25_000, String(quiet.capturedMs));
    check('MEM-67: ...and it is stamped inFlight: true, because it may still be a draft',
      quiet.inFlightStamped, quiet.text.split('\n').filter((l) => /inFlight/.test(l)).join(' | ') || '(no inFlight line)');
    check('MEM-67: ...the completed exchange is there too (the fix did not trade one for the other)',
      quiet.hasDone);
    check('MEM-67: ...and a client asking `latest` through the same live server gets it back',
      JSON.stringify(quiet.latest || {}).includes('x-beadfeed-'),
      JSON.stringify(quiet.latest || {}).slice(0, 200));
    check('MEM-67: ...the stamp no longer says work was left behind',
      !!quiet.stamp && !quiet.stamp.deferred, JSON.stringify(quiet.stamp));

    // ---- THE CONTROL. The same fixture, still moving -----------------------------------------
    // If this one captured the in-flight exchange too, the "fix" would just be MEM-18 again: a
    // half-written answer searchable as though it were the last word.
    const live = await runOnce({ dir: join(dir, 'live'), quietMin: 0, waitMs: 10_000, waitFor: null });
    console.log(`  info  quiet 0 min: ${live.files.length} store file(s), live token present: ${live.hasLive}`);

    check('CONTROL — a transcript that moved seconds ago still has its in-flight exchange DEFERRED',
      !live.hasLive, JSON.stringify({ files: live.files }));
    check('CONTROL — ...while the COMPLETED exchange is captured, so capture demonstrably ran',
      live.hasDone && live.files.length === 1, JSON.stringify({ files: live.files }));
    check('CONTROL — ...and the debounce stamp records that an exchange was left behind, which is '
        + 'what keeps the walker coming back to it',
      !!live.stamp && live.stamp.deferred === true, JSON.stringify(live.stamp));
  } finally {
    cleanupSandbox(dir, { label: 'inflight-quiet-capture-e2e' });
  }
}

// Runnable on its own: `node test/public/inflight-quiet-capture-e2e.mjs`
if (process.argv[1] && process.argv[1].endsWith('inflight-quiet-capture-e2e.mjs')) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); } };
  await inflightQuietCaptureE2E({ check, group: (t) => console.log(`\n=== ${t} ===`) });
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
