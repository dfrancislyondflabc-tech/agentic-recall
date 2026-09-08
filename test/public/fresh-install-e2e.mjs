// test/public/fresh-install-e2e.mjs — THE FIRST FIVE MINUTES OF AN INSTALL THAT HAS NOTHING.
//
// test/public/scheduler-e2e.mjs proves a loaded server captures. It does NOT prove the server can
// then READ what it captured, and for one specific reason: its only pre-capture query is a
// `search` on the curated scope, so the STAGING scope is first loaded after the walker has already
// written the index. A real fresh install is the other order — somebody asks a question, gets
// nothing (there is nothing yet), keeps the conversation open, and asks again after capture has
// run. That is the order this file uses, and on release-1.7.1 it never recovers:
//
//   A-D1 (campaign A, 2026-09-05): lib/search.js ensureFresh adopted a newer on-disk index only
//   `if (onDiskBuiltAt && loadedBuiltAt)`. A process that started index-less has loadedBuiltAt
//   null forever — `present:false` is cached per scope like any other load — so the branch could
//   never fire. Measured: same server 0 rows after the build, a FRESH server over the identical
//   files 3 rows, `indexBuiltAt` null against a complete index on disk.
//
// WHAT IS REAL: a real `node index.js` MCP server over stdio, the real scheduler, the real walker,
// the real extractor, the real index build, and the real query path. Fixtures: the transcript, the
// three pre-written store files, and the clock knobs.
//
// 🟥 THE ASSERTION MUST NOT BE SATISFIABLE BY THE DIRECT READ. Once the index HAS the exchange,
// `_staleScan` is empty and a row can only come from the index — so the final check demands both
// `indexBuiltAt` non-null and a provenance that is NOT 'unindexed-direct'. Restoring the
// `&& loadedBuiltAt` requirement in ensureFresh fails it.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnOptsForKill } from './kill-tree.mjs';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(dirname(HERE));                       // repo root, derived — never written down

const SID = 'facefeed-1111-2222-3333-444455556666';
const TOKEN = 'freshtoken9042';                            // the CAPTURED exchange's token

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mdFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')) : []);

/** One complete exchange plus the following human turn that makes it complete under --defer-last. */
function writeTranscript(path) {
  const prose = (n) => Array.from({ length: n }, (_, i) =>
    `The rim was tensioned evenly and the nipples seated on pass ${i} before the wheel was dished.`).join(' ');
  const lines = [
    { type: 'user', timestamp: '2026-09-05T06:00:00.000Z',
      message: { role: 'user', content: `Write up what we settled about wheel dishing and file it under ${TOKEN}. ${prose(2)}` } },
    { type: 'assistant', timestamp: '2026-09-05T06:00:04.000Z',
      message: { role: 'assistant', content: [{ type: 'text',
        text: `Settled for ${TOKEN}: dish to the locknuts, never to the rim tape. ${prose(9)}` }] } },
    { type: 'user', timestamp: '2026-09-05T06:05:00.000Z',
      message: { role: 'user', content: 'understood, nothing else for now' } }
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/** A real MCP client over the real server's stdio. */
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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    rpc,
    child,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    stderr: () => errText,
    // 🟥 MEM-69. Was `child.kill()`, which on Windows neither reaches the scheduler's capture
    // grandchildren nor blocks until the server is actually gone — and the rmSync three lines
    // later then hit an open handle. stopChild is killTree + an awaited exit.
    close: () => { try { child.stdin.end(); } catch { /* gone */ } return stopChild(child); }
  };
}

const rowsOf = (b) => [...(Array.isArray(b?.results) ? b.results : []),
  ...((Array.isArray(b?.sections) ? b.sections : []).flatMap((s) => (Array.isArray(s.results) ? s.results : [])))];

/**
 * @param {object} o
 * @param {(name:string, ok:boolean, detail?:string)=>void} o.check
 * @param {(t:string)=>void} o.group
 */
export async function freshInstallE2E({ check, group }) {
  group('a server born with NO index — it must adopt the first one capture builds, in its own process');

  const dir = mkdtempSync(join(tmpdir(), 'fresh-e2e-'));
  const projects = join(dir, '.claude', 'projects', 'proj');
  const store = join(dir, 'store');
  const mem = join(dir, 'mem');
  mkdirSync(projects, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(mem, { recursive: true });
  writeTranscript(join(projects, `${SID}.jsonl`));

  // The extractor FAILS CLOSED on a denylist it cannot read, and MEMORY_ROOT moves where it looks.
  const secrets = join(dir, 'secrets-exclude.json');
  writeFileSync(secrets, JSON.stringify({
    _comment: 'fixture written by test/public/fresh-install-e2e.mjs',
    excludeFiles: [], sectionScrub: {}, patterns: [], tokenHashesSha256: []
  }, null, 2) + '\n');

  const stamp = join(dir, 'timed-capture-last.json');
  const stagingIdx = join(dir, 'staging.json');
  const env = {
    ...process.env,
    HOME: dir, USERPROFILE: dir,
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
    MEMORY_INGEST_LOG: join(dir, 'ingest-runs.jsonl'),
    MEMORY_TIMED_CAPTURE_STAMP: stamp,
    MEMORY_TIMED_CAPTURE_LOCK: join(dir, 'timed-capture.lock'),
    MEMORY_PENDING_INDEX: join(dir, 'pending-index.json'),
    MEMORY_RECONCILE_STAMP: join(dir, 'last-reconcile.json'),
    MEMORY_VANISH_LOG: join(dir, 'vanish.jsonl'),
    MEMORY_RECALL_CANARY: '0',
    MEMORY_QUERY_SOURCE: 'test',
    MEMORY_ACCOUNT: 'fresh-install-e2e',
    MEMORY_AUTO_INGEST: 'always',
    MEMORY_INGEST_DEBOUNCE_SEC: '0',
    MEMORY_CAPTURE_SCRIPT: join(TREE, 'scripts', 'timed-capture.mjs'),
    MEMORY_SCHEDULER: '1',
    MEMORY_SCHEDULER_INTERVAL_SEC: '2',
    MEMORY_SCHEDULER_TICK_MS: '500',
    MEMORY_SCHEDULER_JITTER_SEC: '0'
  };

  const srv = startServer(env);
  let handshake = null, blind = null, after = null, capturedMs = null;
  const t0 = Date.now();
  try {
    handshake = await srv.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'fresh-install-e2e', version: '1.0.0' }
    });
    srv.notify('notifications/initialized', {});

    // ---- THE BLIND QUERY. This is what loads the staging scope while no index file exists, and
    // it is the step scheduler-e2e never takes. Everything after it depends on this cache entry.
    const b = await srv.rpc('tools/call', { name: 'memory',
      arguments: { action: 'latest', query: TOKEN, scope: 'staging', limit: 5 } });
    try { blind = JSON.parse(b.result.content[0].text); } catch { blind = { __unparsable: true }; }

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (mdFiles(store).some((f) => f.startsWith('x-facefeed-')) && existsSync(stagingIdx)) {
        capturedMs = Date.now() - t0; break;
      }
      await sleep(250);
    }
    // A moment for the walker's index rename to land after the file appears.
    await sleep(500);

    const a = await srv.rpc('tools/call', { name: 'memory',
      arguments: { action: 'latest', query: TOKEN, scope: 'staging', limit: 5 } });
    try { after = JSON.parse(a.result.content[0].text); } catch { after = { __unparsable: true }; }
  } finally {
    await srv.close();
  }

  console.log(`  info  fresh install: capture+index at ${capturedMs ?? 'never'} ms, store now ${mdFiles(store).length} file(s)`);
  if (!capturedMs) console.log(`  info  server stderr: ${srv.stderr().split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400)}`);

  // The state the server starts in, and the state A-D1 left it in FOREVER: no index, and it says so.
  // 🟥 MEM-85 — `indexStale === true` WAS THE PROXY FOR "no index", and on a fresh install whose
  // store is still empty it is the wrong one: 0 corpus files AND no index is EMPTY, not behind
  // (lib/search.js ensureFresh). Calling that state stale is what let one 0-file corpus set the
  // verdict for a whole scope:'all' response on 2026-09-07. The property this check exists for has
  // not moved — the scope was LOADED, there is no index file, and the response SAYS so — so both
  // states are accepted and whichever one is claimed must be internally consistent.
  const saidNoIndex = blind?.empty === true
    ? /no index/i.test(String(blind?.emptyNote || blind?.note)) && blind?.indexStale === false
    : blind?.indexStale === true && /no index/i.test(String(blind?.staleWarning || blind?.note));
  check('the first query really did load the staging scope with no index on disk',
    blind?.indexBuiltAt === null && saidNoIndex,
    JSON.stringify({ empty: blind?.empty ?? false, stale: blind?.indexStale, builtAt: blind?.indexBuiltAt,
      warn: String(blind?.emptyNote || blind?.staleWarning || blind?.note).slice(0, 110) }));

  // ---- A-D1 — the SAME process adopts the index its own capture built -------------------------
  const rows = rowsOf(after);
  const hit = rows.find((r) => /^x-facefeed-/.test(String(r?.name)));
  check('the captured exchange came back through the SAME server that booted index-less',
    !!hit, JSON.stringify({ rows: rows.length, names: rows.map((r) => r?.name).slice(0, 3),
      note: String(after?.note || after?.error || '').slice(0, 140) }));
  // 🟥 `indexStale` IS DELIBERATELY NOT ASSERTED. The scheduler is on a 2-second interval here, so
  // a later tick can touch the store between the build and the query and make the answer honestly
  // stale — a property of the fixture's clock, not of adoption. What adoption means is exactly
  // this: the process that booted with no index is now reading one. (Observed once as a flake
  // asserting `indexStale === false`: builtAt set, adoption plainly working, stale true.)
  check('...FROM THE INDEX — indexBuiltAt is set, so this cannot be the direct read passing',
    typeof after?.indexBuiltAt === 'string' && after.indexBuiltAt.length > 0,
    JSON.stringify({ builtAt: after?.indexBuiltAt, stale: after?.indexStale }));
  check('...and the row itself is an indexed row, not an unindexed-direct one',
    !!hit && hit.provenance !== 'unindexed-direct', JSON.stringify(hit?.provenance ?? null));

  // Cleanup is not an assertion: MEM-69 was 130/130 checks lost to a `rmSync` that threw.
  cleanupSandbox(dir, { label: 'fresh-install-e2e' });
}
