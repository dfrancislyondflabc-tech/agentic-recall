// test/public/finished-turn-capture-e2e.mjs — MEM-77/78/80: the three 1.7.3 capture fixes, live.
//
// 🟥 THE CLAIM UNDER TEST is the one the Windows PC measured twice and failed twice: switch the
// connector on, no Stop hook, no LaunchAgent, and the thing you just said is remembered.
//
//   1.7.1 §3.4  three scheduler ticks over ELEVEN MINUTES and the newest exchange never appeared.
//               A timed run deferred the exchange with no later human turn, and in a live chat the
//               newest exchange is the final one by construction — so it was deferred for ever.
//   1.7.2 F4    the hook works, and labels every capture `inFlight: true`, because at Stop time
//               there is by definition no next user turn. A flag that is always on is not a flag.
//   1.7.2 F2    a one-line session — "…the zebra token is ZEBRA-6118." / "Noted." — was captured by
//               NO path: the reply is under the 200-character floor, and the fact was in the ASK.
//   MEM-78      `uncapturedSessions` counted four `<scheduled-task …>` sessions the writer refuses
//               by design, and the walker spent four of its eight per-tick slots selecting them.
//
// All four are one fixture and one walk, because they happen on one machine at one moment: a live
// chat whose newest turn has STOPPED (`stop_reason: end_turn`), a short-reply exchange whose ask
// carries an identifier, and a robot session sitting beside it in the same project directory.
//
// WHAT IS REAL HERE: a real `node index.js` MCP server over stdio, its real in-process scheduler,
// the real walker it spawns, the real auto-ingest, the real extractor, a real index build and a
// real `latest` through the same live server. The fixtures are the transcripts, the corpus and the
// 2-second interval. The transcript mtime is deliberately FRESH — quiet ≈ 0 — so the MEM-67 quiet
// rule cannot be what captures anything here. If the final exchange lands, it landed because the
// transcript said the turn was over.
//
// WHY IT IS PUBLIC: this is the hook-less configuration, which is what windows-latest runs. A fix
// proved only on the author's Mac, where the Stop hook hides the defect, is not proved.
//
// WHAT IT REFUSES TO ACCEPT AS A PASS: the control run, whose only difference is `tool_use` instead
// of `end_turn` on that same last record, must NOT capture the final exchange. Without it this is
// MEM-18 again — a half-written answer searchable as though it were the last word.

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
const SID = 'fa15ed01-1111-2222-3333-444455556666';
const TASK_SID = 'c0dedbad-1111-2222-3333-444455556666';
const DONE_TOKEN = 'finishdone7731';                       // in the first, plainly complete exchange
const ASK_TOKEN = 'ZEBRA-6118';                            // MEM-80: the fact is in the ASK
const LAST_TOKEN = 'finishlast5528';                       // in the FINAL exchange — the subject
const ROBOT_TOKEN = 'robotprice9902';                      // must never reach the store

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mdFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')) : []);
const storeText = (d) => mdFiles(d).map((f) => readFileSync(join(d, f), 'utf8')).join('\n');

/**
 * A live conversation, exactly as a client writes one.
 *
 * Three exchanges. The first is plainly complete (a later human turn follows it). The second is the
 * MEM-80 shape: a one-line statement carrying an identifier, answered in one word. The third has no
 * later human turn at all — the shape every open chat is in — and `stopReason` is the whole subject.
 */
function writeTranscript(path, stopReason) {
  const prose = (n) => Array.from({ length: n }, (_, i) =>
    `The rim was trued and the spoke tension checked on pass ${i} before the hub went back together.`).join(' ');
  const A = (text, ts, sr) => ({ type: 'assistant', timestamp: ts,
    message: { role: 'assistant', stop_reason: sr, content: [{ type: 'text', text }] } });
  const U = (content, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content } });
  const lines = [
    U(`What did we settle about the freehub service? File it under ${DONE_TOKEN}. ${prose(2)}`, '2026-09-06T06:00:00.000Z'),
    A(`Settled for ${DONE_TOKEN}: the pawls take light oil and never the thick bearing grease. ${prose(9)}`, '2026-09-06T06:00:04.000Z', 'end_turn'),
    U(`Note for the record: the zebra token is ${ASK_TOKEN}.`, '2026-09-06T06:02:00.000Z'),
    A('Noted.', '2026-09-06T06:02:01.000Z', 'end_turn'),
    U(`And the pawl spring measurement — record it as ${LAST_TOKEN}. ${prose(2)}`, '2026-09-06T06:05:00.000Z'),
    A(`For ${LAST_TOKEN} the pawl spring measures 0.4 mm of free travel at the seat. ${prose(9)}`, '2026-09-06T06:05:06.000Z', stopReason)
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

/** A scheduled task: a robot run, in the same project directory, that must never become memory. */
function writeTaskTranscript(path) {
  const lines = [
    { type: 'user', timestamp: '2026-09-06T06:01:00.000Z',
      message: { role: 'user', content: '<scheduled-task name="bh-ds925-price-log" file="/tasks/price/SKILL.md">\nThis is an automated run.\n</scheduled-task>' } },
    { type: 'assistant', timestamp: '2026-09-06T06:01:20.000Z',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text',
        text: `Logged ${ROBOT_TOKEN}: the price row was appended to the sheet and nothing else happened. `.repeat(6) }] } }
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
    // killTree, not a bare kill: the server spawns the walker, which spawns auto-ingest, which
    // spawns the extractor (MEM-69).
    close: () => { try { child.stdin.end(); } catch { /* gone */ } return stopChild(child); }
  };
}

/**
 * One run of the fixture under a live server.
 *
 * @param {object} o
 * @param {string} o.dir         sandbox
 * @param {string} o.stopReason  what the LAST assistant record says about itself
 * @param {number} o.waitMs      how long to keep the server alive
 * @param {string} [o.waitFor]   stop early once this token is in the store
 * @returns observations, not verdicts — the caller does the asserting
 */
async function runOnce({ dir, stopReason, waitMs, waitFor }) {
  const projects = join(dir, '.claude', 'projects', 'proj');
  const store = join(dir, 'store');
  const mem = join(dir, 'mem');
  mkdirSync(projects, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(mem, { recursive: true });
  for (const f of readdirSync(FIXTURES)) if (f.endsWith('.md')) writeFileSync(join(mem, f), readFileSync(join(FIXTURES, f)));
  const tx = writeTranscript(join(projects, `${SID}.jsonl`), stopReason);
  writeTaskTranscript(join(projects, `${TASK_SID}.jsonl`));
  // NO utimes: the transcript was written a moment ago, which is what a LIVE chat looks like. The
  // MEM-67 quiet rule needs ten minutes of silence, so it cannot be the thing that captures here.

  // An empty fixture denylist, as scripts/verify-stdio.js does it: the extractor FAILS CLOSED on a
  // denylist it cannot read, so without this the test would be measuring the sandbox.
  const secrets = join(dir, 'secrets-exclude.json');
  writeFileSync(secrets, JSON.stringify({
    _comment: 'fixture written by test/public/finished-turn-capture-e2e.mjs',
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
    MEMORY_ACCOUNT: 'finished-turn-e2e',
    MEMORY_AUTO_INGEST: 'always',         // bypass the heartbeat gate, not the capture logic
    MEMORY_INGEST_DEBOUNCE_SEC: '0',
    MEMORY_CAPTURE_SCRIPT: join(TREE, 'scripts', 'timed-capture.mjs'),
    MEMORY_SCHEDULER: '1',
    MEMORY_SCHEDULER_INTERVAL_SEC: '2',
    MEMORY_SCHEDULER_TICK_MS: '500',
    MEMORY_SCHEDULER_JITTER_SEC: '0'
    // MEMORY_INFLIGHT_QUIET_MIN deliberately UNSET (10 min) and MEMORY_CAPTURE_INCLUDE_TASKS unset:
    // a fresh install is what is under test.
  };

  const t0 = Date.now();
  const srv = startServer(env);
  let capturedMs = null, latest = null;
  try {
    await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'finished-turn-e2e', version: '1.0.0' } });
    srv.notify('notifications/initialized', {});
    await srv.rpc('tools/call', { name: 'memory', arguments: { action: 'search', query: 'light oil on the pawls', limit: 2 } });

    const stampOf = () => { try { return JSON.parse(readFileSync(join(store, '.last-ingest.json'), 'utf8'))[tx] || null; } catch { return null; } };
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (waitFor && capturedMs === null && storeText(store).includes(waitFor)) capturedMs = Date.now() - t0;
      // The file lands BEFORE the run ends: auto-ingest writes the store, then builds the index,
      // then stamps in its `finally`. Wait for the run's own bookkeeping rather than reading it out
      // of a run this harness interrupted; capturedMs still records the first sighting.
      if (capturedMs !== null && stampOf()) break;
      await sleep(400);
    }
    const r = await srv.rpc('tools/call', { name: 'memory', arguments: { action: 'latest', scope: 'staging', limit: 5 } });
    try { latest = JSON.parse(r?.result?.content?.[0]?.text || '{}'); } catch { latest = null; }
  } finally {
    srv.close();
    await sleep(300);                      // let the tree actually go before anything is deleted
  }

  const text = storeText(store);
  const rows = existsSync(runLog)
    ? readFileSync(runLog, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  return { ms: Date.now() - t0, capturedMs, files: mdFiles(store), text, rows, latest,
    hasDone: text.includes(DONE_TOKEN), hasAsk: text.includes(ASK_TOKEN), hasLast: text.includes(LAST_TOKEN),
    hasRobot: text.includes(ROBOT_TOKEN),
    inFlightStamped: /^\s*inFlight:\s*true\s*$/m.test(text), stderr: srv.stderr() };
}

export async function finishedTurnCaptureE2E({ check, group }) {
  group('MEM-77/78/80 — a live server captures a FINISHED turn on the next tick, and leaves the robot alone');
  const dir = mkdtempSync(join(tmpdir(), 'finished-e2e-'));
  try {
    // ---- THE FIX. The last record says the model stopped -------------------------------------
    // 25 s is a ceiling, not an expectation: the first walk carries the model load and the first
    // index build. Before MEM-77 this run could not capture the final exchange at ANY duration —
    // the walker deferred it on every tick, for ever, exactly as measured on the Windows PC.
    const fin = await runOnce({ dir: join(dir, 'finished'), stopReason: 'end_turn', waitMs: 25_000, waitFor: LAST_TOKEN });
    console.log(`  info  end_turn: last token in the store after ${fin.capturedMs ?? 'NEVER'} ms ` +
      `(${fin.files.length} file(s), run rows ${fin.rows.map((r) => r.outcome).join(',') || 'none'})`);

    check('MEM-77: the FINAL exchange of a live chat is captured by the TIMER alone once the '
        + 'transcript says the turn stopped — no Stop hook, no ten-minute wait',
      fin.hasLast, JSON.stringify({ files: fin.files, capturedMs: fin.capturedMs,
        stderr: fin.stderr.split('\n').filter((l) => /defer|complete|summary/.test(l)).slice(-3) }));
    check('MEM-77: ...within one scheduler window, not three ticks and eleven minutes',
      Number.isFinite(fin.capturedMs) && fin.capturedMs < 25_000, String(fin.capturedMs));
    check('MEM-77: ...and it is NOT stamped inFlight — a finished turn is not a draft (1.7.2 F4)',
      !fin.inFlightStamped, fin.text.split('\n').filter((l) => /inFlight/.test(l)).join(' | ') || '(no inFlight line)');
    check('MEM-77: ...the earlier, plainly complete exchange is there too',
      fin.hasDone);
    check('MEM-80: ...and so is the one-line exchange whose FACT IS IN THE ASK, answered "Noted."',
      fin.hasAsk, JSON.stringify(fin.files));
    check('MEM-78: the scheduled-task session sitting beside it reached the store NOWHERE',
      !fin.hasRobot && !fin.files.some((f) => f.startsWith(`x-${TASK_SID.slice(0, 8)}`)),
      JSON.stringify(fin.files));
    check('MEM-78: ...and the walker said so once, rather than spending a slot on it every tick',
      fin.rows.some((r) => r.trigger === 'walker' && r.excluded && r.excluded.count === 1
        && r.excluded.reasons['scheduled-task'] === 1),
      JSON.stringify(fin.rows.filter((r) => r.trigger === 'walker').slice(-2)));
    check('MEM-77: ...and a client asking `latest` through the same live server gets the exchanges back',
      JSON.stringify(fin.latest || {}).includes(`x-${SID.slice(0, 8)}-`),
      JSON.stringify(fin.latest || {}).slice(0, 200));

    // ---- THE CONTROL. One field different, and the turn is still in flight --------------------
    // If this captured the last exchange too, the "fix" would be MEM-18 again: a half-written
    // answer searchable as though it were the last word.
    const mid = await runOnce({ dir: join(dir, 'midturn'), stopReason: 'tool_use', waitMs: 12_000, waitFor: null });
    console.log(`  info  tool_use: ${mid.files.length} store file(s), last token present: ${mid.hasLast}`);
    check('CONTROL — the SAME fixture whose last record says tool_use still DEFERS its final '
        + 'exchange: the exemption is the model saying it stopped, not the field being present',
      !mid.hasLast, JSON.stringify({ files: mid.files }));
    check('CONTROL — ...while everything before it is captured, so capture demonstrably ran',
      mid.hasDone && mid.hasAsk, JSON.stringify({ files: mid.files, done: mid.hasDone, ask: mid.hasAsk }));
  } finally {
    cleanupSandbox(dir, { label: 'finished-turn-capture-e2e' });
  }
}

// Runnable on its own: `node test/public/finished-turn-capture-e2e.mjs`
if (process.argv[1] && process.argv[1].endsWith('finished-turn-capture-e2e.mjs')) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); } };
  await finishedTurnCaptureE2E({ check, group: (t) => console.log(`\n=== ${t} ===`) });
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
