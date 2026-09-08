// test/public/campaign-lite.mjs — the 1.7.1 test campaign, small enough to run everywhere.
//
//   node test/public/campaign-lite.mjs                 all five blocks, ~10 minutes
//   MEMORY_CAMPAIGN_ONLY=B1,B3 node test/public/campaign-lite.mjs
//   MEMORY_PUBLIC_CAMPAIGN=1 npm run test:full         registered inside the public suite
//
// WHAT THIS IS. Blocks A, B.1, B.3, B.4 and C.2 of MEMORY-MCP-TEST-CAMPAIGN-1.7.1.md, shrunk from
// hours to minutes and made self-contained so they can run on a CI runner and on a recipient's
// machine — the campaign proper lives in private worktrees, was run once, by hand, on the author's
// Mac, and proved nothing about Windows. This file is the part that runs on windows-latest every
// push to a release branch.
//
//   A-lite   the 5-minute promise, at 30 s: two conversations grow under a REAL server with the
//            in-server scheduler on, and every exchange must become recallable inside one interval
//            plus one tick plus slack — while every answer along the way either RETURNS the
//            exchange or NAMES it.
//   B.1      six secret shapes through the capture path, then read back through every output path
//            including the query log, the canary log and stderr.
//   B.3      a denylisted file and a `metadata.secret` file, left unindexed: the direct-read path,
//            the recency warning, the session directory and the canary must all stay silent.
//   B.4      the MCP surface under abuse: huge queries, absurd limits, 50 at once.
//   C.2      seven hostile things in the store: the server keeps answering, and the next reconcile
//            repairs what can be repaired.
//
// 🟥 WHY IT IS SANDBOXED THE WAY IT IS. It starts real servers, spawns the real walker and the real
// extractor, and leaves corrupt files lying about. Everything writable is redirected into one
// mkdtemp directory: HOME **and** USERPROFILE (os.homedir() reads the second on Windows, and
// setting only the first sandboxes two platforms out of three), plus every path-valued env var in
// REDIRECTS below. Every process it starts is killed with killTree, which is taskkill /T on
// Windows — a plain SIGKILL of a negative pid does not exist there, so a harness that used one
// would silently stop being a harness.
//
// 🟥 THE `KNOWN` LIST IS THE POINT OF THE DESIGN. Five defects found by the full campaign are being
// fixed on other branches RIGHT NOW. A test suite that is red for them is a suite nobody reads; a
// suite that does not test them at all goes quiet when they come back. So each affected assertion
// names its ledger id: it reports KNOWN-<id> instead of FAIL, and the run stays green. When the fix
// merges the assertion starts PASSING — and this file says so, loudly, as "KNOWN-<id> did NOT
// fire", which is the signal to delete the marker. An unfired KNOWN is either a landed fix or a
// weak test, and both need somebody to look.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
         readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killTree, spawnOptsForKill } from './kill-tree.mjs';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(dirname(HERE));
const GOLD = join(TREE, 'test', 'fixtures', 'gold-corpus');
const WALKER = join(TREE, 'scripts', 'timed-capture.mjs');

// =================================================================================================
// THE KNOWN LIST — one line per ledger id, and nothing is marked KNOWN without one.
// =================================================================================================
//
// 🟥 MEM-75, 2026-09-06 — NINE OF THE ELEVEN MARKERS WERE STALE, AND A STALE MARKER IS WORSE THAN
// NO TEST. Each of these named a fix "in progress on branch X"; those branches merged into 1.7.1
// and 1.7.2 months of work ago, so every one of those assertions had been PASSING while still
// reporting `PASS!<id>` — and would have gone back to reporting KNOWN, quietly, the day the fix
// regressed. Removed after measuring, not after reading: a full run on main (2026-09-06, macOS,
// 64 PASS / 2 KNOWN / 0 FAIL) showed B5-AMPLIFY, MEM-41, MEM-42, MEM-45, MEM-51, MEM-56 and
// MEM-59 in the "did NOT fire" list — the signal this file prints for exactly this decision.
// Those seven assertions are now STRICT.
//
// The two that DID fire are both kept, and neither of them was what its marker said:
//   * MEM-44's arm fired because of a defect in this FILE, not in the product — see B.3.
//     Fixed there; the marker is gone.
//   * MEM-43's arm fired on ONE of its three secrets. Re-pointed at MEM-79, which is what it is.
const KNOWN = {
  // OPEN. Not the MEM-43 call-order defect (fixed in 1.7.1: the AWS-key and JWT arms of the same
  // loop are strict now and pass). A BARE password typed as the query carries no keyword and no
  // credential shape — 'Zx9-Quokka-Lantern-42' is a hyphenated word string — so redact() has
  // nothing to recognise. MEM-79's prose rule ("my password is X") does not reach it either: there
  // is no sentence, only the token. Kept as the one marker with a live ledger id.
  'MEM-79': 'a password with no keyword and no credential shape, typed AS THE QUERY, reaches .query-log.jsonl — redact() matches shapes and assignments, and a bare hyphenated token is neither (open; the prose rule on wp-173-prose-password does not cover the bare-query form)',
  // OPPORTUNISTIC (see below): a race, so a quiet run is a clean run rather than a landed fix.
  'MEM-48': 'uncapturedSessions is memoised for 60 s with no growth invalidation, so a response can name other sessions as behind and omit yours (race-dependent)'
};

/**
 * KNOWN ids that fire only if a RACE happens to be lost during the run — as opposed to the
 * deterministic ones above, which fire on every single run. An opportunistic id that stays quiet is
 * a clean run, not a weak test, so it is reported separately and never raises the "did NOT fire"
 * alarm; a deterministic one that stays quiet means the fix landed or the assertion went blind.
 */
const OPPORTUNISTIC = new Set(['MEM-48']);

// =================================================================================================
// The sandbox
// =================================================================================================
//
// 🟥 DUPLICATED FROM test/sandbox-env.js ON PURPOSE, AND CHECKED AGAINST IT.
// That file lives at test/ root, which does not ship (packaging/release-exclude.json excludes
// `test` wholesale and names back only test/public and test/fixtures/gold-corpus). Importing it
// would make this file work in the repo and throw in every release — the exact shape of the bug
// scripts/audit-read-paths.mjs exists to catch. So the list is inlined, and `assertRedirectsMatch`
// below reads the real file AS TEXT when it is present and fails loudly if the two ever diverge:
// a duplicate that cannot rot is worth more than an import that cannot ship.
const REDIRECTS = Object.freeze({
  MEMORY_INDEX: 'index.json',
  MEMORY_STAGING_INDEX: 'staging-index.json',
  MEMORY_HANDOFF_INDEX: 'handoff-index.json',
  MEMORY_PROJECTS_INDEX: 'projects-index.json',
  MEMORY_LIBRARY_INDEX_DIR: '.',
  MEMORY_QUERY_LOG: 'q.jsonl',
  MEMORY_PROBE_RESULTS: 'probe-results.json',
  MEMORY_MARGIN_HISTORY: 'margins.jsonl',
  MEMORY_VECTOR_CACHE: 'vector-cache.json',
  MEMORY_INGEST_LOG: 'ingest-runs.jsonl',
  MEMORY_VANISH_LOG: 'vanish-report.jsonl',
  MEMORY_PENDING_INDEX: 'pending-index.json',
  MEMORY_RECONCILE_STAMP: 'last-reconcile.json',
  MEMORY_RECALL_CANARY_LOG: 'recall-canary.jsonl',
  MEMORY_RECALL_CANARY_STATE: 'recall-canary-state.json',
  MEMORY_TIMED_CAPTURE_STAMP: 'timed-capture-last.json',
  MEMORY_TIMED_CAPTURE_LOCK: 'timed-capture.lock',
  // The audit tick's three (MEM-50). Added to test/sandbox-env.js when the audit shipped and
  // NOT here — so `redirectsDrift()` below, the check whose whole job is to catch that, was
  // reporting three missing keys. Found while shipping sandbox-env.js in the zip (MEM-68/U-2):
  // the drift check only ever ran where the file existed, which is the repo, where nobody read
  // its result. All three default under MEMORY_OWN_STORE, which this harness already sandboxes,
  // so nothing escaped — the list was wrong, not the sandbox.
  MEMORY_STORE_AUDIT_STAMP: 'store-audit-last.json',
  MEMORY_STORE_AUDIT_LOCK: 'store-audit.lock',
  MEMORY_STORE_SNAPSHOT_DIR: 'store-snapshots'
});

/** The source-repo cross-check for the duplication above. Silent in a release tree. */
function redirectsDrift() {
  const p = join(TREE, 'test', 'sandbox-env.js');
  if (!existsSync(p)) return null;                       // release tree: nothing to compare against
  let src;
  try { src = readFileSync(p, 'utf8'); } catch { return null; }
  const block = src.slice(src.indexOf('REDIRECTS = Object.freeze({'), src.indexOf('/**\n * The env for a spawned script'));
  const theirs = [...block.matchAll(/^\s*(MEMORY_[A-Z0-9_]+):/gm)].map((m) => m[1]).sort();
  const mine = Object.keys(REDIRECTS).sort();
  if (!theirs.length) return 'could not parse test/sandbox-env.js REDIRECTS';
  const missing = theirs.filter((k) => !mine.includes(k));
  const extra = mine.filter((k) => !theirs.includes(k));
  return (missing.length || extra.length)
    ? `missing here: ${missing.join(',') || 'none'}; not in sandbox-env.js: ${extra.join(',') || 'none'}` : null;
}

let SANDBOXES = [];

/**
 * One sandbox: a HOME of its own, a curated corpus, an own-store, an index dir, transcripts, and a
 * redaction policy copied in (lib/secrets.js FAILS CLOSED on a policy it cannot read, correctly —
 * which without this would turn every security assertion into a test of the sandbox).
 */
function makeSandbox(label, { excludeFiles = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `campaign-${label}-`));
  SANDBOXES.push(dir);
  const transcripts = join(dir, '.claude', 'projects', 'p-campaign');
  const mem = join(dir, 'mem');
  const store = join(dir, 'store');
  const idx = join(dir, 'idx');
  for (const d of [transcripts, mem, store, idx]) mkdirSync(d, { recursive: true });
  for (const f of readdirSync(GOLD)) if (f.endsWith('.md')) copyFileSync(join(GOLD, f), join(mem, f));

  const policyPath = join(dir, 'secrets-exclude.json');
  const policy = JSON.parse(readFileSync(join(TREE, 'secrets-exclude.json'), 'utf8'));
  policy.excludeFiles = excludeFiles;          // the author's own denied filename is not ours to plant
  policy.tokenHashesSha256 = [];                // hashes of the author's real credentials; irrelevant here
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n');

  const env = { ...process.env };
  for (const [k, base] of Object.entries(REDIRECTS)) env[k] = base === '.' ? idx : join(idx, base);
  Object.assign(env, {
    HOME: dir,
    USERPROFILE: dir,
    MEMORY_ROOT: dir,
    MEMORY_DIR: mem,
    MEMORY_OWN_STORE: store,
    MEMORY_TRANSCRIPT_DIR: transcripts,
    MEMORY_SECRETS_CONFIG: policyPath,
    MEMORY_MODEL_CACHE: join(TREE, '.model-cache'),
    MEMORY_HANDOFF_INDEX: '0',
    MEMORY_PROJECTS_INDEX: '0',
    MEMORY_LIBRARY: '0',
    MEMORY_ALL_PROJECTS: '0',
    MEMORY_AUTHOR_CORPUS: '0',
    MEMORY_HANDOFF_DIRS: '',
    MEMORY_GIT_REPOS: '',
    MEMORY_ACCOUNT: 'campaign-lite',
    MEMORY_QUERY_SOURCE: 'test',
    // 'always' bypasses the heartbeat gate: a test that waited on a 60-second liveness mark would
    // be measuring the clock, not capture. Everything else in the write path is production.
    MEMORY_AUTO_INGEST: 'always',
    MEMORY_INGEST_DEBOUNCE_SEC: '0',
    MEMORY_FRESHNESS_TTL_MS: '0',
    MEMORY_INLINE_REINDEX: '0',
    MEMORY_CAPTURE_SCRIPT: WALKER
  });
  // The store-resident writer state stays in store/, where production keeps it.
  env.MEMORY_INGEST_LOG = join(store, '.ingest-runs.jsonl');
  env.MEMORY_TIMED_CAPTURE_STAMP = join(store, '.timed-capture-last.json');
  env.MEMORY_TIMED_CAPTURE_LOCK = join(store, '.timed-capture.lock');
  env.MEMORY_RECALL_CANARY_LOG = join(store, '.recall-canary.jsonl');
  env.MEMORY_RECALL_CANARY_STATE = join(store, '.recall-canary-state.json');

  return { dir, transcripts, mem, store, idx, env, policyPath,
    staging: env.MEMORY_STAGING_INDEX, curated: env.MEMORY_INDEX, qlog: env.MEMORY_QUERY_LOG,
    canary: env.MEMORY_RECALL_CANARY_LOG, runlog: env.MEMORY_INGEST_LOG };
}

// =================================================================================================
// A real MCP client over a real server's stdio (shape from test/public/scheduler-e2e.mjs)
// =================================================================================================
function startServer(env, { scheduler = false, intervalSec = 30, tickMs = 5000 } = {}) {
  const e = {
    ...env,
    MEMORY_SCHEDULER: scheduler ? '1' : '0',
    MEMORY_SCHEDULER_INTERVAL_SEC: String(intervalSec),
    MEMORY_SCHEDULER_TICK_MS: String(tickMs),
    MEMORY_SCHEDULER_JITTER_SEC: '0'
  };
  const child = spawn(process.execPath, [join(TREE, 'index.js')],
    { cwd: TREE, env: e, stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptsForKill() });
  let buf = '', errText = '', nextId = 1, nonJson = 0;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { nonJson++; continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  child.stderr.on('data', (d) => { errText += d.toString(); });
  const rpc = (method, params, timeoutMs = 60_000) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: true, method }); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (err) { clearTimeout(timer); pending.delete(id); resolve({ __writeError: String(err.message) }); }
  });
  return {
    child, rpc, pid: child.pid,
    notify: (m, p) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: p }) + '\n'); } catch { /* gone */ } },
    stderr: () => errText,
    nonJson: () => nonJson,
    // killTree, not child.kill(): the server spawns the walker, which spawns auto-ingest, which
    // spawns the extractor. Killing only the parent leaves writers running into the sandbox.
    // MEM-69: and AWAIT the exit — issuing the kill is not the same as the handles being released,
    // which is what the sandbox rm needs on Windows. Returns a promise; the driver awaits it.
    close: () => { try { child.stdin.end(); } catch { /* gone */ } return stopChild(child); }
  };
}

// Every server this file starts, so a block that THROWS half way through cannot leave a live
// `node index.js` (and the walker tree under it) behind holding the runner. The driver closes
// whatever is still open in its cleanup.
const SERVERS = new Set();

async function connect(env, opts) {
  const srv = startServer(env, opts);
  SERVERS.add(srv);
  const rawClose = srv.close;
  srv.close = () => { SERVERS.delete(srv); return rawClose(); };   // MEM-69: hand the promise on
  const h = await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'campaign-lite', version: '1.0.0' } }, 120_000);
  srv.notify('notifications/initialized', {});
  srv.serverInfo = h?.result?.serverInfo || null;
  srv.call = async (args, timeoutMs = 60_000) => {
    const t = Date.now();
    const r = await srv.rpc('tools/call', { name: 'memory', arguments: args }, timeoutMs);
    if (r?.__timeout) return { timeout: true, ms: Date.now() - t, text: '', body: null };
    const text = r?.result?.content?.[0]?.text ?? '';
    let body = null; try { body = JSON.parse(text); } catch { /* non-JSON is itself a datum */ }
    return { ms: Date.now() - t, text, body, bytes: Buffer.byteLength(text, 'utf8'), isError: r?.result?.isError === true };
  };
  return srv;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mdFiles = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.md')); } catch { return []; } };
const jsonl = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return { __torn: l.slice(0, 120) }; } }); } catch { return []; } };
const slurp = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

/** One synchronous walk with the REAL walker — the production write path, run to completion. */
function walkNow(sb, why = 'campaign') {
  const t = Date.now();
  const r = spawnSync(process.execPath, [WALKER],
    { env: { ...sb.env, MEMORY_TIMER_SOURCE: why }, cwd: TREE, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
  return { ms: Date.now() - t, status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

// =================================================================================================
// A minimal transcript writer — the shapes of test/recall-stress/transcript-writer.mjs, inlined
// =================================================================================================
//
// Three dependencies on the extractor, named so a change to any of them breaks loudly rather than
// quietly capturing nothing:
//   * a reply must clear MIN_REPLY_CHARS (200, ingest-transcript.js:74) — these are ~700
//   * an ask must not read as machinery (isMachineTurn) — plain prose, zero angle brackets
//   * the session id's first 8 characters must be hex with no hyphen — the name is `x-<sid8>-<ts>`
const WORDS = ['spoke', 'rim', 'hub', 'caliper', 'grease', 'freehub', 'tension', 'truing', 'valve',
  'tape', 'pawl', 'bearing', 'cassette', 'chain', 'derailleur', 'dropout', 'headset', 'sealant'];

class Chat {
  constructor({ sid, dir, seed, topic }) {
    this.sid = sid; this.sid8 = sid.slice(0, 8);
    this.path = join(dir, `${sid}.jsonl`);
    this.topic = topic; this.n = 0;
    let s = seed >>> 0;
    this.rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    this.clock = Date.now() - 90 * 60_000;
    writeFileSync(this.path, '');
  }
  #line(o) { appendFileSync(this.path, JSON.stringify(o) + '\n', 'utf8'); }
  #tick(ms = 1500) { this.clock += ms; return new Date(this.clock).toISOString(); }
  #prose(min, salt) {
    const out = []; let len = 0, i = 0;
    while (len < min) {
      const n = 8 + Math.floor(this.rnd() * 10);
      const s = Array.from({ length: n }, () => WORDS[Math.floor(this.rnd() * WORDS.length)]).join(' ');
      const line = `${s} for ${salt} pass ${i++}.`;
      out.push(line); len += line.length + 1;
    }
    return out.join(' ');
  }
  /** One COMPLETE exchange: ask, reply, and the following human turn that ends the turn. */
  add({ ask = null, reply = null } = {}) {
    const n = ++this.n;
    const token = `RCL-${this.sid8}-${String(n).padStart(3, '0')}`;
    // The clock is advanced to NOW so the walker's freshness window sees the growth.
    this.clock = Math.max(this.clock + 1500, Date.now());
    const askTs = new Date(this.clock).toISOString();
    const name = `x-${this.sid8}-${askTs.replace(/[-:.]/g, '')}`;
    this.#line({ type: 'user', timestamp: askTs, message: { role: 'user',
      content: ask || `Please write up what we settled about ${this.topic} and file it under ${token}. ${this.#prose(140, token)}` } });
    this.#line({ type: 'assistant', timestamp: this.#tick(1200), message: { role: 'assistant',
      content: [{ type: 'text', text: reply || `Settled for ${token} on ${this.topic}: ${this.#prose(700, token)}` }] } });
    // 🟥 THE ZERO POINT OF THE SLO. `--timed` DEFERS the exchange still in flight, so an exchange
    // becomes capturable when the NEXT human turn lands, not when its reply does. Writing that turn
    // here makes t(append) the instant the exchange is capturable; measuring from the reply would
    // fold the length of the user's next silence into the number, which is not a property of the
    // product. (Campaign A, "the zero point of the SLO, stated because it is a judgement".)
    this.#line({ type: 'user', timestamp: this.#tick(400), message: { role: 'user', content: 'thanks, that is all for now' } });
    return { name, token, n, at: Date.now() };
  }
}

// =================================================================================================
// Reporting
// =================================================================================================
const ROWS = [];
let OUTER = null;                                        // the public suite's check(), when embedded
const knownFired = new Set();
const knownAsked = new Set();

function record(block, name, ok, { known = null, detail = '' } = {}) {
  if (known && !KNOWN[known]) throw new Error(`unknown ledger id '${known}' — add it to KNOWN`);
  if (known) knownAsked.add(known);
  let status;
  if (ok) status = known ? `PASS!${known}` : 'PASS';     // PASS on a KNOWN row: the fix may have landed
  else if (known) { status = `KNOWN-${known}`; knownFired.add(known); }
  else status = 'FAIL';
  ROWS.push({ block, name, status, detail: String(detail).slice(0, 400) });
  const line = `[${block}] ${name}`;
  if (OUTER) OUTER(line + (status.startsWith('KNOWN') ? ` — ${status}` : ''), status !== 'FAIL', String(detail).slice(0, 200));
  else console.log(`  ${status === 'FAIL' ? '✗' : ' '} ${status.padEnd(18)} ${line}${status === 'FAIL' ? `\n      ${String(detail).slice(0, 300)}` : ''}`);
  return ok;
}
const say = (...a) => console.log(...a);

// =================================================================================================
// The honesty oracle (test/recall-stress/oracle.mjs, re-implemented here so this file ships alone)
// =================================================================================================
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const allNodes = (b) => [b, ...arr(b?.sections), ...Object.values(b?.groups || {})].filter(Boolean);
const rowsOf = (b) => { const out = []; for (const n of allNodes(b)) out.push(...arr(n.results)); return out; };
const returnsTarget = (b, t) => rowsOf(b).some((r) => r && (r.name === t.name || r.file === t.name));

/** Every honesty channel that NAMES this file. */
function namesTarget(body, t) {
  const hits = [];
  for (const n of allNodes(body)) {
    const rv = n.recencyVoid;
    if (rv && arr(rv.unreadFiles).some((f) => String(f).includes(t.name))) hits.push('recencyVoid.unreadFiles');
    if (rv && arr(rv.stillBeingWritten).some((f) => String(f).includes(t.name))) hits.push('recencyVoid.stillBeingWritten');
    const fu = n.foundInUnindexed;
    if (fu && Object.values(fu).some((v) => arr(v).some((f) => String(f).includes(t.name)))) hits.push('foundInUnindexed');
    const ru = n.recentUnindexed;
    if (ru && arr(ru.files).some((f) => String(f?.file || f).includes(t.name))) hits.push('recentUnindexed');
    for (const k of ['staleFilesAdded', 'staleFilesChanged']) {
      if (arr(n[k]).some((f) => String(f).includes(t.name))) hits.push(k);
    }
    if (arr(n.results).some((r) => r?.provenance === 'unindexed-direct' && r.name === t.name)) hits.push('provenance:unindexed-direct');
  }
  return [...new Set(hits)];
}

/**
 * `uncapturedSessions`, read in BOTH shapes.
 * The shipped stamp is `{count, sessions:[{session,…}]}`; the private oracle reads an ARRAY of
 * `{session}` and therefore never matches it — which turns a response that IS naming the gap into
 * a false DISHONEST. Campaign A corrected this in its harness rather than in the shipped oracle;
 * the correction is carried here for the same reason.
 */
function namesSession(body, sid) {
  for (const n of allNodes(body)) {
    const u = n.uncapturedSessions;
    if (!u) continue;
    const list = Array.isArray(u) ? u : Array.isArray(u.sessions) ? u.sessions : [u];
    if (list.some((x) => String(x?.session || x).includes(String(sid).slice(0, 8)))) return ['uncapturedSessions'];
  }
  return [];
}

/**
 * PRESENT / NAMED / DISHONEST — the campaign's definition, verbatim: DISHONEST is rows returned
 * while the newest file is neither returned nor named anywhere.
 */
function classify(body, target, inStore) {
  const rows = rowsOf(body).length;
  if (!body) return { verdict: 'DISHONEST', kind: 'D-NO-BODY', channels: [], rows: 0 };
  if (returnsTarget(body, target)) return { verdict: 'PRESENT', channels: namesTarget(body, target), rows };
  const named = namesTarget(body, target);
  if (named.length) return { verdict: 'NAMED', channels: named, rows };
  const bySession = namesSession(body, target.sid);
  if (bySession.length) return { verdict: 'NAMED', channels: bySession, rows };
  if (!rows) return { verdict: 'EMPTY', channels: [], rows: 0 };
  return { verdict: 'DISHONEST', kind: inStore ? 'D-ROWS' : 'D-UNCAPTURED', channels: [], rows };
}

// =================================================================================================
// BLOCK A-lite — the 5-minute promise, run at 30 seconds
// =================================================================================================
//
// The production interval is 300 s ticked every 60 s. Here it is 30 s ticked every 5 s, jitter
// pinned to 0, and the SLO scales with it: one interval + one tick + 30 s of slack = 65 s. Nothing
// else is a fixture — a real `node index.js` over stdio, the real in-server scheduler, the real
// walker it spawns, the real extractor, the real index build.
//
// 🟥 THE PRE-SEED, and it is a workaround for a live defect, not a convenience.
// MEM-46: a server that BOOTS with no staging index on disk never adopts the one capture later
// creates (`lib/search.js ensureFresh` needs BOTH an on-disk and a loaded builtAt). On a fresh
// sandbox that makes the SLO unmeasurable — nothing is ever recallable, for one reason, and the
// block learns nothing about anything else. So one exchange per conversation is captured by a
// SYNCHRONOUS walker run BEFORE the server boots, exactly as a machine that has been running for a
// while would be, and those two exchanges are not graded. Delete the pre-seed when MEM-46 lands.
async function blockA() {
  // 210 + 120 keeps the whole file inside its 12-minute promise on the slowest runner while still
  // grading ~14 exchanges across ~11 walks. Both are env knobs: a longer local soak is one variable.
  const APPEND_SEC = Number(process.env.MEMORY_CAMPAIGN_APPEND_SEC ?? 210);
  const DRAIN_SEC = Number(process.env.MEMORY_CAMPAIGN_DRAIN_SEC ?? 120);
  const INTERVAL = 30, TICK_MS = 5000;
  const SLO_SEC = INTERVAL + TICK_MS / 1000 + 30;        // 65 s: one interval + one tick + slack

  say(`\n--- A-lite: ${APPEND_SEC}s of appends + ${DRAIN_SEC}s drain, interval ${INTERVAL}s, tick ${TICK_MS}ms, SLO ${SLO_SEC}s`);
  const sb = makeSandbox('A');
  const chats = [
    new Chat({ sid: 'a1b2c3d4-1111-2222-3333-444455550001', dir: sb.transcripts, seed: 73310, topic: 'CAMPTOPICWHEELS' }),
    new Chat({ sid: 'e5f6a7b8-1111-2222-3333-444455550002', dir: sb.transcripts, seed: 51117, topic: 'CAMPTOPICBRAKES' })
  ];

  for (const c of chats) c.add();                        // the pre-seed exchanges, not graded
  const seed = walkNow(sb, 'preseed');
  record('A', 'the pre-seed walk captured both conversations before the server booted',
    mdFiles(sb.store).length === 2 && existsSync(sb.staging),
    { detail: `store=${mdFiles(sb.store).length} staging=${existsSync(sb.staging)} status=${seed.status} ${seed.stdout.split('\n').filter(Boolean).slice(-2).join(' | ')}` });

  const srv = await connect(sb.env, { scheduler: true, intervalSec: INTERVAL, tickMs: TICK_MS });
  record('A', 'the real MCP server answered the handshake', srv.serverInfo?.name === 'agentic-recall', { detail: JSON.stringify(srv.serverInfo) });

  const EX = new Map();
  const dishonest = [];                                  // {name, t, kind, resolvedWithinMs}
  const t0 = Date.now();
  let polls = 0;

  const poll = async () => {
    polls++;
    const pending = [...EX.values()].filter((r) => r.recallableAt === null).sort((a, b) => a.at - b.at);
    for (const r of pending) {
      const res = await srv.call({ action: 'latest', query: r.token, scope: 'staging', limit: 8 }, 45_000);
      if (res.timeout) { r.timeouts++; continue; }
      const inStore = existsSync(join(sb.store, `${r.name}.md`));
      if (inStore && r.storeAt === null) r.storeAt = Date.now();
      const v = classify(res.body, { name: r.name, sid: r.sid }, inStore);
      r.polls++;
      if (v.verdict === 'PRESENT') { r.recallableAt = Date.now(); r.channels = v.channels; }
      else if (v.verdict === 'NAMED') r.named++;
      else if (v.verdict === 'DISHONEST') {
        r.dishonestAt ??= Date.now();
        dishonest.push({ name: r.name, tSec: Math.round((Date.now() - t0) / 1000), kind: v.kind, rows: v.rows,
          bodyKeys: Object.keys(res.body || {}).slice(0, 20) });
      }
      // A DISHONEST instant that clears within 60 s is MEM-48's memo, not a lie that persists.
      if (r.dishonestAt && v.verdict !== 'DISHONEST') r.dishonestCleared ??= Date.now();
    }
  };

  // Appends: one exchange every 30 s overall, the two conversations 15 s out of phase.
  const appendDeadline = Date.now() + APPEND_SEC * 1000;
  let turn = 0;
  while (Date.now() < appendDeadline) {
    const c = chats[turn % chats.length];
    const rec = c.add();
    EX.set(rec.name, { ...rec, sid: c.sid, storeAt: null, recallableAt: null, dishonestAt: null,
      dishonestCleared: null, polls: 0, named: 0, timeouts: 0, channels: [] });
    turn++;
    // A 5-second cadence that INCLUDES the poll's own cost: sleeping a flat 5 s after a cycle
    // that took 4 would silently make the sampling interval 9 s and inflate every measured lag.
    const until = Date.now() + 15_000;
    while (Date.now() < until) { const next = Date.now() + 5000; await poll(); await sleep(Math.max(0, next - Date.now())); }
  }
  // Drain: keep polling until everything is recallable or the budget runs out.
  const drainDeadline = Date.now() + DRAIN_SEC * 1000;
  while (Date.now() < drainDeadline && [...EX.values()].some((r) => r.recallableAt === null)) {
    const next = Date.now() + 5000; await poll(); await sleep(Math.max(0, next - Date.now()));
  }

  const runRows = jsonl(sb.runlog);
  const walkerStarts = runRows.filter((r) => r.trigger === 'walker' && r.outcome === 'started');
  const captureHealth = [];
  const sess = await srv.call({ action: 'sessions', limit: 20 });
  if (sess.body && Object.prototype.hasOwnProperty.call(sess.body, 'captureHealth')) captureHealth.push(sess.body.captureHealth);
  const stderrText = srv.stderr();
  await srv.close();

  // ---- the verdicts -----------------------------------------------------------------------
  const all = [...EX.values()];
  const lags = all.filter((r) => r.recallableAt).map((r) => (r.recallableAt - r.at) / 1000).sort((a, b) => a - b);
  const never = all.filter((r) => !r.recallableAt);
  const p = (q) => (lags.length ? lags[Math.min(lags.length - 1, Math.floor(q * lags.length))] : null);
  const p100 = lags.length ? lags[lags.length - 1] : null;
  say(`    ${all.length} graded exchanges, ${lags.length} recallable, ${never.length} never; ` +
      `p50 ${p(0.5)}s p95 ${p(0.95)}s p100 ${p100}s; ${polls} poll cycles; ${walkerStarts.length} walker starts`);

  record('A', 'every appended exchange became recallable', never.length === 0,
    { detail: never.length ? `never recallable: ${never.map((r) => `${r.name}(store=${!!r.storeAt},polls=${r.polls},named=${r.named})`).join(' ')}` : `${lags.length} of ${all.length}` });
  record('A', `p100 time-to-recallable is inside one interval + one tick + slack (${SLO_SEC}s)`,
    p100 !== null && p100 <= SLO_SEC, { detail: `p50=${p(0.5)}s p95=${p(0.95)}s p100=${p100}s over ${lags.length} exchanges` });

  const lostExchanges = all.filter((r) => !existsSync(join(sb.store, `${r.name}.md`)));
  record('A', '0 lost exchanges — every exchange the transcript holds has a store file',
    lostExchanges.length === 0, { detail: lostExchanges.map((r) => r.name).join(' ') || `${all.length} of ${all.length} present` });

  // DISHONEST, split by whether it cleared inside MEM-48's 60-second memo window.
  const persistent = all.filter((r) => r.dishonestAt && (!r.dishonestCleared || r.dishonestCleared - r.dishonestAt > 60_000));
  const transient = all.filter((r) => r.dishonestAt && r.dishonestCleared && r.dishonestCleared - r.dishonestAt <= 60_000);
  record('A', '0 DISHONEST answers that outlive the 60 s capture-status memo', persistent.length === 0,
    { detail: persistent.length ? JSON.stringify(dishonest.slice(0, 4)) : `${dishonest.length} DISHONEST instants, all transient` });
  record('A', '0 DISHONEST answers at all', dishonest.length === 0, { known: 'MEM-48',
    detail: `${dishonest.length} instants over ${transient.length} exchange(s); first: ${JSON.stringify(dishonest[0] || null)}` });

  // One walk per interval, +-1 for the boundaries.
  const elapsed = (Date.now() - t0) / 1000;
  const expected = Math.floor(elapsed / INTERVAL);
  record('A', 'exactly one walk per interval — the lock held and no tick doubled up',
    Math.abs(walkerStarts.length - expected) <= 1,
    { detail: `${walkerStarts.length} walker starts over ${Math.round(elapsed)}s at a ${INTERVAL}s interval (expected ~${expected})` });
  record('A', 'captureHealth was never stamped unhealthy in a healthy run',
    !captureHealth.some((h) => String(h?.status || h) === 'unhealthy'), { detail: JSON.stringify(captureHealth).slice(0, 200) });
  record('A', 'the server wrote nothing but JSON-RPC to stdout', srv.nonJson() === 0, { detail: `${srv.nonJson()} non-JSON lines` });
  record('A', 'no unhandled rejection in the server log',
    !/UnhandledPromiseRejection|Unhandled promise rejection/i.test(stderrText), { detail: stderrText.slice(-300) });

  return { p50: p(0.5), p95: p(0.95), p100, graded: all.length, never: never.length,
    dishonestInstants: dishonest.length, walkerStarts: walkerStarts.length, polls,
    elapsedSec: Math.round(elapsed) };
}

// =================================================================================================
// BLOCK B.1-lite — secrets through every path
// =================================================================================================
//
// Every value below is INVENTED. Nothing here is, or resembles, a real credential belonging to
// anyone: the AWS id is a random 16-character body, the PEM is base64 of nothing, the JWT is signed
// with a signature that is not one. That matters because this file ships.
//
// The shapes are planted in ONE synthetic exchange and pushed through the REAL capture path (the
// walker → auto-ingest → the extractor), then read back through search / latest / sessions / get,
// the query log (with the secret ITSELF typed as the query), the canary log and stderr.
//
// TWO OF THEM ARE EXPECTED TO SURVIVE, and the distinction is the whole value of the block:
//   * the PEM BODY — MEM-42, a defect, marked KNOWN.
//   * a private IPv4 — NOT a defect. Ruled deliberately (STRESS-LOG round 3): a private address is
//     a release-deny.json concern, not a runtime scrub, because scrubbing it would shred every
//     memory about this machine's own network. The assertion below therefore asserts THE RULING,
//     so a silent change of mind shows up here as a failure rather than as a surprise.
const SECRETS = {
  aws: 'AKIAQ7ZK3MPLW2XNVT4B',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjYW1wYWlnbmxpdGUiLCJpYXQiOjF9.Kt7QvZmXbN2pLd9RfTgHwYs4CxEuAoJi1KzMnPqRsTv',
  password: 'Zx9-Quokka-Lantern-42',
  pemBody: 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
  // Assembled at run time: the release gate refuses a private-IPv4 LITERAL in shipped source, and it is
  // right to — this file ships. The planted value is unchanged.
  ip: [10, 20, 30, 44].join('.'),
  // TWO invented addresses, in two places, because they test two different things: the one in the
  // REPLY proves the extractor's scrubAddresses() turns a body address into `[email@domain]`, and
  // the one in the OPENING ASK proves what deriveTitle() does with it — which is nothing (MEM-45).
  // No dots in either local part: deriveTitle splits the first user turn on `[.?!\n]`, so a dotted
  // local part would cut the title in half before the address ever got into it.
  emailLocal: 'zaphodbeeblebrox42',
  emailDomain: 'notkept-example.org',
  titleEmailLocal: 'mrtitleleak77'
};
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${SECRETS.pemBody}\nKkQEAgEBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8QuKUpR\n-----END RSA PRIVATE KEY-----`;

async function blockB1() {
  say('\n--- B.1-lite: six secret shapes through the capture path and back out of every read path');
  const sb = makeSandbox('B1');
  const sid = 'b1c2d3e4-1111-2222-3333-444455550011';
  const chat = new Chat({ sid, dir: sb.transcripts, seed: 20260905, topic: 'CAMPSECRETS' });

  // The opening ask becomes `description` AND `metadata.sessionTitle` (deriveTitle takes the first
  // sentence of the first user turn, capped at 80 characters). The AWS id goes there ON PURPOSE:
  // the description is scrubbed and the title is not, which is MEM-45.
  // 73 characters up to the first `.`, so both the key and the address's identity half survive
  // deriveTitle's `split(/[.?!\n]/)[0].slice(0, 80)` and land in metadata.sessionTitle.
  const ask = `Record deploy key ${SECRETS.aws} from ${SECRETS.titleEmailLocal}@${SECRETS.emailDomain} for the rig. `
    + 'We went through the whole configuration and wrote down each part so it can be repeated later.';
  const reply = [
    `Noted. The service account line is password: ${SECRETS.password} and must be rotated quarterly.`,
    `The bearer material is a token ${SECRETS.jwt} which the agent presents on every call.`,
    `The signing key is stored as:\n${PEM}\nand the operator keeps a copy offline.`,
    `The rig answers on ${SECRETS.ip} inside the workshop network and nowhere else.`,
    `Questions go to ${SECRETS.emailLocal}@${SECRETS.emailDomain} who owns the rota.`,
    'The rest of the write-up covers the bench procedure in the ordinary way. '
      + Array.from({ length: 9 }, (_, i) => `The wheel was trued and the spoke tension checked on pass ${i} before the hub was reassembled.`).join(' ')
  ].join('\n\n');
  chat.add({ ask, reply });

  const walk = walkNow(sb, 'b1');
  const files = mdFiles(sb.store);
  record('B.1', 'the exchange was captured through the real extractor', files.length === 1,
    { detail: `${files.length} store file(s); status ${walk.status}; ${walk.stdout.split('\n').filter(Boolean).slice(-2).join(' | ')}` });
  if (!files.length) return { skipped: 'nothing captured' };

  const storeText = slurp(join(sb.store, files[0]));
  const indexText = slurp(sb.staging);

  const srv = await connect(sb.env, { scheduler: false });
  const reads = {};
  reads.searchStaging = await srv.call({ action: 'search', query: 'deploy key workshop rig rotation', scope: 'staging', limit: 8 });
  reads.latestTerm = await srv.call({ action: 'latest', query: 'workshop', scope: 'staging', limit: 8 });
  reads.latestBrowse = await srv.call({ action: 'latest', scope: 'staging', limit: 8 });
  reads.sessions = await srv.call({ action: 'sessions', scope: 'staging', limit: 10 });
  reads.getFull = await srv.call({ action: 'get', name: files[0].replace(/\.md$/, '') });
  reads.getBrief = await srv.call({ action: 'get', name: files[0].replace(/\.md$/, ''), brief: true });
  reads.thread = await srv.call({ action: 'thread', name: files[0].replace(/\.md$/, '') });

  // THE SECRET ITSELF, TYPED AS THE QUERY — the path that writes the caller's words to disk.
  // `pw:` and not `password:` — a bare `password: <expression>` is a credential SHAPE, and the
  // release scrubber (correctly) cannot tell a member expression from a literal. Writing it the
  // other way made this file scrub into a SyntaxError, which is the MEM-64 class one file over.
  for (const [k, v] of Object.entries({ aws: SECRETS.aws, jwt: SECRETS.jwt, pw: SECRETS.password })) {
    await srv.call({ action: 'latest', query: v, scope: 'staging', limit: 3 });
    await srv.call({ action: 'search', query: v, scope: 'staging', limit: 3 });
    reads[`typed-${k}`] = { text: '' };                  // recorded for shape; the assertion is on the log
  }
  const stderrText = srv.stderr();
  await srv.close();

  const qlogText = slurp(sb.qlog);
  const canaryText = slurp(sb.canary);
  const readText = Object.entries(reads).map(([k, r]) => `${k}::${r.text || ''}`).join('\n');

  const where = (needle) => {
    const hits = [];
    if (storeText.includes(needle)) hits.push('store');
    if (indexText.includes(needle)) hits.push('index');
    for (const [k, r] of Object.entries(reads)) if ((r.text || '').includes(needle)) hits.push(k);
    if (canaryText.includes(needle)) hits.push('canary-log');
    if (stderrText.includes(needle)) hits.push('stderr');
    return hits;
  };

  // ---- the eight shapes, each against every path -------------------------------------------
  for (const [label, needle] of [['an AWS access key id', SECRETS.aws], ['a JWT', SECRETS.jwt],
    ['a `password:` line', SECRETS.password]]) {
    const hits = where(needle);
    // MEM-45 puts the OPENING ASK's secret into metadata.sessionTitle unredacted, so the AWS id —
    // and only the AWS id, because only it is in the ask — reaches the store, the index and the
    // session directory. Marked against that id, not against MEM-42.
    const known = null;   // STRICT since MEM-75: deriveTitle() scrubs internally (b747a6a), and this stopped firing
    record('B.1', `${label} reaches no store file, no index and no response`, hits.length === 0,
      { known, detail: hits.length ? `leaked into: ${hits.join(', ')}` : 'clean on every path' });
  }
  record('B.1', 'a PEM private key BODY reaches no store file, no index and no response',
    where(SECRETS.pemBody).length === 0, { detail: `leaked into: ${where(SECRETS.pemBody).join(', ') || 'nothing'}` });   // STRICT since MEM-75
  record('B.1', 'the PEM BEGIN line is redacted even though the body is not',
    !storeText.includes('-----BEGIN RSA PRIVATE KEY-----'),
    { detail: storeText.includes('-----BEGIN RSA PRIVATE KEY-----') ? 'the header survived too' : 'header redacted' });
  record('B.1', "the local part of a non-kept address never survives capture (it becomes `[email@domain]`)",
    !storeText.includes(SECRETS.emailLocal) && !readText.includes(SECRETS.emailLocal),
    { detail: where(SECRETS.emailLocal).join(', ') || 'scrubbed' });
  // The RULING, asserted as a ruling: a private IPv4 is deliberately NOT a runtime scrub.
  record('B.1', 'RULING — a private IPv4 is deliberately kept (release-deny concern, not a runtime scrub)',
    storeText.includes(SECRETS.ip),
    { detail: storeText.includes(SECRETS.ip) ? 'kept, as ruled' : 'it is now being scrubbed — the ruling changed and this test did not' });
  record('B.1', 'something in the store was actually redacted, so the scrubber ran at all',
    /\[REDACTED:/.test(storeText), { detail: (storeText.match(/\[REDACTED:[a-z-]+\]/g) || []).slice(0, 6).join(' ') });

  // ---- the query log: the secret as the query ----------------------------------------------
  // MEM-43 (logQuery redacts the row itself, so call order cannot matter) landed in 1.7.1, and the
  // two SHAPED secrets have been passing ever since — they are strict now. The password arm is a
  // different defect wearing MEM-43's marker: 'Zx9-Quokka-Lantern-42' carries no keyword and
  // matches no credential shape, so there is nothing for redact() to recognise when it arrives as
  // the whole query. That is MEM-79's family, and MEM-79's prose rule does not reach it either.
  for (const [label, needle, known] of [['an AWS key', SECRETS.aws, null], ['a JWT', SECRETS.jwt, null],
    ['a password', SECRETS.password, 'MEM-79']]) {
    record('B.1', `${label} typed AS THE QUERY does not reach the query log`, !qlogText.includes(needle),
      { known, detail: qlogText.includes(needle) ? 'present in .query-log.jsonl in plaintext' : 'absent' });
  }
  record('B.1', 'the query log was written at all, so its emptiness is not what passed the checks',
    qlogText.trim().length > 0, { detail: `${qlogText.split('\n').filter(Boolean).length} rows` });
  record('B.1', 'no secret reached the canary log', !Object.values(SECRETS).some((v) => canaryText.includes(v)),
    { detail: canaryText.slice(0, 200) });
  record('B.1', 'no secret reached stderr', !Object.values(SECRETS).some((v) => stderrText.includes(v)),
    { detail: stderrText.slice(-200) });

  // sessions().title is its own path and its own defect.
  const sessRows = reads.sessions.body?.sessions || [];
  const titles = JSON.stringify(sessRows.map((s) => s.title || s.sessionTitle || ''));
  record('B.1', 'the session directory returned our conversation, so its titles are really being read',
    sessRows.length > 0, { detail: `${sessRows.length} session row(s)` });
  record('B.1', 'no secret and no address identity reaches sessions().title',
    !Object.values(SECRETS).some((v) => titles.includes(v)),
    { detail: titles.slice(0, 240) });   // STRICT since MEM-75

  return { storeBytes: storeText.length, redactions: (storeText.match(/\[REDACTED:/g) || []).length };
}

// =================================================================================================
// BLOCK B.3-lite — the denylist and `metadata.secret` through the NEW paths
// =================================================================================================
//
// loadCorpus refuses both at INDEX time, and always has. WP1's direct read of unindexed files, the
// recency warning that names them, the session directory and the recall canary are all newer paths
// that reach the store WITHOUT going through the index — which is exactly where an exclusion gets
// forgotten. Both files are left unindexed on purpose: an excluded file that is also indexed proves
// nothing about the direct read.
async function blockB3() {
  say('\n--- B.3-lite: a denylisted file and a metadata.secret file, left unindexed');
  const DENIED = 'campaign-denied-notes.md';
  const sb = makeSandbox('B3', { excludeFiles: [DENIED] });
  const TOK_DENY = 'DENYTOKEN7742';
  const TOK_SECRET = 'SECRETTOKEN9931';
  const SID = 'c1c2c3c4-1111-2222-3333-444455550031';

  const doc = (name, sid, ts, body, extra = '') =>
    `---\nname: ${name}\ndescription: "a campaign fixture"\nmetadata:\n  type: exchange\n  sessionId: ${sid}\n  sessionTitle: "campaign fixture"\n  ts: ${ts}\n${extra}---\n\n**Asked:** a campaign fixture\n\n${body}\n`;

  // One ordinary exchange first, INDEXED, so `latest` has rows to be honest or dishonest about.
  writeFileSync(join(sb.store, 'x-c1c2c3c4-20260901T010000000Z.md'),
    doc('x-c1c2c3c4-20260901T010000000Z', SID, '2026-09-01T01:00:00.000Z',
      'The ordinary exchange talks about wheel truing and spoke tension in the workshop, at length, so it indexes.'));
  const build = spawnSync(process.execPath, ['-e',
    "const C=await import(process.env.__CFG);const{buildIndex}=await import(process.env.__IDX);" +
    "const r=await buildIndex({force:true,dir:C.rootsForCorpus('staging'),out:C.stagingIndexPath()});console.log('indexed',r.filesIndexed);"],
  { env: { ...sb.env, __CFG: pathToFileURL(join(TREE, 'lib', 'config.js')).href, __IDX: pathToFileURL(join(TREE, 'lib', 'index-store.js')).href },
    cwd: TREE, encoding: 'utf8', windowsHide: true });
  record('B.3', 'the ordinary exchange indexed, so the unindexed files are the only new thing',
    /indexed 1/.test(String(build.stdout)), { detail: String(build.stdout || build.stderr).slice(0, 200) });

  // NOW the two excluded files, newer than the index and never indexed.
  const nowIso = new Date().toISOString();
  writeFileSync(join(sb.store, DENIED),
    doc('campaign-denied-notes', SID, nowIso, `The denied notes mention ${TOK_DENY} and the workshop rig repeatedly.`));
  writeFileSync(join(sb.store, 'x-c1c2c3c4-20260904T010000000Z.md'),
    doc('x-c1c2c3c4-20260904T010000000Z', SID, nowIso,
      `The secret-marked exchange mentions ${TOK_SECRET} and the workshop rig repeatedly.`, '  secret: true\n'));

  const srv = await connect(sb.env, { scheduler: false });
  // TWO probe sets, kept apart on purpose. A response ECHOES the caller's own query, so asking for
  // the secret token and then grepping the whole response for it finds the caller's words and calls
  // them a leak — a false positive that would make this block permanently and wrongly red. The
  // CONTENT scan therefore asks only topic questions; the token questions are used solely to see
  // which excluded file the honesty channels NAME.
  const probes = {
    latestTopic: await srv.call({ action: 'latest', query: 'workshop rig', scope: 'staging', limit: 8 }),
    searchTopic: await srv.call({ action: 'search', query: 'the workshop rig and its notes', scope: 'staging', limit: 8 }),
    sessions: await srv.call({ action: 'sessions', scope: 'staging', limit: 10 }),
    browse: await srv.call({ action: 'latest', scope: 'staging', limit: 10 })
  };
  const tokenProbes = {
    latestDenyToken: await srv.call({ action: 'latest', query: TOK_DENY, scope: 'staging', limit: 8 }),
    latestSecretToken: await srv.call({ action: 'latest', query: TOK_SECRET, scope: 'staging', limit: 8 })
  };
  const stderrText = srv.stderr();
  await srv.close();

  const blob = Object.entries(probes).map(([k, r]) => `${k}::${r.text || ''}`).join('\n');
  for (const [what, tok] of [['a denylisted-name file', TOK_DENY], ['a `metadata.secret` file', TOK_SECRET]]) {
    record('B.3', `${what} never surfaces its content through a topic query`, !blob.includes(tok),
      { detail: Object.entries(probes).filter(([, r]) => (r.text || '').includes(tok)).map(([k]) => k).join(', ') || 'clean' });
  }
  const allProbes = { ...probes, ...tokenProbes };
  const directRows = Object.values(allProbes).flatMap((r) => rowsOf(r.body)).filter((x) => x?.provenance === 'unindexed-direct');
  record('B.3', 'the direct read of unindexed files returns neither excluded file',
    !directRows.some((r) => String(r.name).includes('campaign-denied') || String(r.name).includes('20260904')),
    { detail: JSON.stringify(directRows.map((r) => r.name)).slice(0, 200) });
  // The BODY is gated (lib/unindexed.js exclusionReason). The NAME is not: the pre-1.7 stale
  // channels still say "your token appears in <denied file>", which is MEM-41.
  const nameBlob = Object.entries(allProbes).map(([k, r]) => `${k}::${r.text || ''}`).join('\n');
  record('B.3', 'no honesty channel NAMES an excluded file (recentUnindexed / recencyVoid / foundInUnindexed)',
    // STRICT since MEM-75: the stale channels stopped naming excluded files in 1.7.1.
    !/campaign-denied-notes/.test(nameBlob), {
      detail: [...new Set(Object.entries(allProbes).filter(([, r]) => /campaign-denied-notes/.test(r.text || '')).map(([k]) => k))].join(', ') });
  const sessCount = (probes.sessions.body?.sessions || []).find((s) => String(s.sessionId).startsWith('c1c2c3c4'))?.count ?? null;
  record('B.3', 'an excluded exchange is not even COUNTED in the session directory', sessCount === 1,
    { detail: `count=${sessCount} (1 ordinary exchange + 2 excluded)` });

  // The canary: it picks a token out of the newest unindexed file and probes with it.
  const walk = walkNow(sb, 'b3-canary');
  const canaryText = slurp(sb.canary);
  const qlogText = slurp(sb.qlog);
  // 🟥 MEM-75/MEM-44 — THE QUERY-LOG HALF WAS SCANNING THIS FILE'S OWN PROBES. `tokenProbes` above
  // deliberately calls `latest` with TOK_DENY and TOK_SECRET as the QUERY, to see which excluded
  // file the honesty channels name; logQuery records every query a caller makes, so both tokens
  // were in .query-log.jsonl before the canary ever ran. The whole-file grep then read the tester's
  // own words as a canary leak and reported KNOWN-MEM-44 on every run since — exactly the false
  // positive the comment beside `tokenProbes` warns about for the CONTENT scan, one channel over.
  // MEM-44's product fix (exclusionReason in recallProbeOnce) is in main and holds: the canary log
  // is clean, and so is every qlog row the CANARY wrote. So the question is asked of those rows
  // only — `src:'canary'`, the tag lib/heartbeat.js:163 puts on the probe through withQuerySource.
  const canaryQlogRows = qlogText.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => r && r.src === 'canary');
  const canaryQlogText = JSON.stringify(canaryQlogRows);
  record('B.3', 'the recall canary never takes its probe token from an excluded file',
    !canaryText.includes(TOK_DENY) && !canaryText.includes(TOK_SECRET)
      && !canaryQlogText.includes(TOK_DENY) && !canaryQlogText.includes(TOK_SECRET),
    { detail: `canary=${canaryText.slice(0, 160)} canaryQlogRows=${canaryQlogRows.length}` });
  // THE CONTROL FOR THE NARROWING. If no row is tagged `src:'canary'` the check above is vacuous —
  // it would pass on a machine where the canary never ran at all.
  record('B.3', '...and the canary DID write query-log rows, so scoping the scan to them is not vacuous',
    canaryQlogRows.length > 0 || canaryText.trim().length > 0,
    { detail: `canaryQlogRows=${canaryQlogRows.length} canaryLogBytes=${canaryText.length}` });
  record('B.3', 'the canary ran at all, so its silence is not what passed the check',
    canaryText.trim().length > 0 || /canary/i.test(walk.stdout + walk.stderr),
    { detail: `${canaryText.split('\n').filter(Boolean).length} canary rows` });
  record('B.3', 'no unhandled rejection while refusing the excluded files',
    !/UnhandledPromiseRejection/i.test(stderrText), { detail: stderrText.slice(-200) });
  return { canaryRows: canaryText.split('\n').filter(Boolean).length };
}

// =================================================================================================
// BLOCK B.4-lite — input hardening of the MCP surface
// =================================================================================================
//
// The full campaign uses 1 MB and 200 concurrent; this uses 200 KB and 50, which is the same
// property at a size a shared runner will not swap over. The bar that matters is not "it did not
// crash" — it is that a caller cannot make the server hand back an unbounded response, and that the
// server is still a server afterwards. The LAST check is therefore the load-bearing one.
async function blockB4() {
  say('\n--- B.4-lite: huge queries, absurd limits, 50 at once');
  const sb = makeSandbox('B4');
  // A real corpus to answer from: the curated gold fixtures, indexed.
  const build = spawnSync(process.execPath, ['-e',
    "const C=await import(process.env.__CFG);const{buildIndex}=await import(process.env.__IDX);" +
    "const r=await buildIndex({force:true,dir:C.rootsForCorpus('curated'),out:C.curatedIndexPath?C.curatedIndexPath():process.env.MEMORY_INDEX});console.log('indexed',r.filesIndexed);"],
  { env: { ...sb.env, __CFG: pathToFileURL(join(TREE, 'lib', 'config.js')).href, __IDX: pathToFileURL(join(TREE, 'lib', 'index-store.js')).href },
    cwd: TREE, encoding: 'utf8', windowsHide: true });
  record('B.4', 'a curated index exists to abuse', /indexed \d+/.test(String(build.stdout)),
    { detail: String(build.stdout || build.stderr).slice(0, 200) });

  const srv = await connect(sb.env, { scheduler: false });
  const CAP = 256 * 1024;
  const bigQuery = 'wheel '.repeat(Math.ceil(200 * 1024 / 6)).slice(0, 200 * 1024);
  const manyTerms = Array.from({ length: 2000 }, (_, i) => `term${i}`).join(' ');

  const cases = [
    ['a 200 KB query (search)', { action: 'search', query: bigQuery, limit: 5 }, null],
    ['a 200 KB query (latest)', { action: 'latest', query: bigQuery, limit: 5 }, null],
    ['a 2 000-term query', { action: 'search', query: manyTerms, limit: 5 }, null],
    ['limit 0', { action: 'search', query: 'wheel truing', limit: 0 }, null],
    ['limit -1', { action: 'search', query: 'wheel truing', limit: -1 }, null],
    ['limit 1e9', { action: 'search', query: 'wheel truing', limit: 1e9 }, null],
    ['limit NaN', { action: 'search', query: 'wheel truing', limit: Number.NaN }, null],
    ['maxChars 1', { action: 'search', query: 'wheel truing', limit: 3, maxChars: 1 }, null],
    ['offset beyond the end', { action: 'search', query: 'wheel truing', limit: 3, offset: 10_000_000 }, null],
    ['a stopword-only query', { action: 'search', query: 'the of and to a an is', limit: 5 }, null]
  ];
  for (const [label, args, known] of cases) {
    const r = await srv.call(args, 90_000);
    const bytes = r.bytes ?? Buffer.byteLength(r.text || '', 'utf8');
    if (process.env.MEMORY_CAMPAIGN_DEBUG) say(`      DEBUG ${label}: ${bytes} bytes`);
    record('B.4', `${label}: the response is bounded (< 256 KB) and the call returns`,
      !r.timeout && bytes < CAP, { known, detail: `${r.timeout ? 'TIMEOUT' : bytes + ' bytes'} in ${r.ms} ms` });
  }

  // ---- AMPLIFICATION, which is the property the 256 KB cap only accidentally covers ----------
  //
  // MEASURED: a 200 KB query comes back as ~211 KB — the caller's own words, echoed. That squeaks
  // under 256 KB, so a cap check alone reports green while the response scales 1:1 with the input;
  // campaign B saw the same defect at 1 MB in and 6.59 MB out. The bound below is on the SHAPE of
  // the relationship rather than on one size: a response may cost a fixed amount plus a quarter of
  // the query, and no more. Kept at 200 KB rather than 1 MB deliberately — a shared runner should
  // not be asked to hold a 7 MB string to prove a schema is missing a maxLength.
  const AMP_BOUND = 64 * 1024 + Math.ceil(Buffer.byteLength(bigQuery, 'utf8') * 0.25);
  for (const action of ['search', 'latest']) {
    const r = await srv.call({ action, query: bigQuery, limit: 5 }, 90_000);
    const bytes = r.bytes ?? 0;
    // STRICT since MEM-75: the schema bound landed in 1.7.1 and this stopped firing.
    record('B.4', `\`${action}\` does not echo a 200 KB query back — the response does not scale with the input`,
      !r.timeout && bytes <= AMP_BOUND,
      { detail: `${bytes} bytes out for ${Buffer.byteLength(bigQuery, 'utf8')} in (bound ${AMP_BOUND})` });
  }

  // 50 at once, on ONE process, all in flight together.
  const t = Date.now();
  const many = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    srv.call({ action: 'search', query: `wheel truing pass ${i}`, limit: 5 }, 120_000)));
  const timeouts = many.filter((r) => r.timeout).length;
  const overCap = many.filter((r) => (r.bytes ?? 0) >= CAP).length;
  record('B.4', '50 concurrent requests: none times out and none exceeds the cap',
    timeouts === 0 && overCap === 0, { detail: `${timeouts} timeouts, ${overCap} over cap, ${Date.now() - t} ms wall` });

  const after = await srv.call({ action: 'search', query: 'light oil on the pawls', limit: 3 }, 60_000);
  record('B.4', 'THE ONE THAT MATTERS — the server still answers an ordinary question afterwards',
    !after.timeout && !!after.body, { detail: `${after.bytes} bytes in ${after.ms} ms, mode ${after.body?.mode ?? 'n/a'}` });
  const stderrText = srv.stderr();
  record('B.4', 'no unhandled rejection anywhere in the abuse run',
    !/UnhandledPromiseRejection|Unhandled promise rejection/i.test(stderrText), { detail: stderrText.slice(-300) });
  record('B.4', 'the server never wrote a non-JSON line to stdout', srv.nonJson() === 0, { detail: `${srv.nonJson()} lines` });
  await srv.close();
  return { concurrentMs: Date.now() - t };
}

// =================================================================================================
// BLOCK C.2-lite — hostile files in the store
// =================================================================================================
//
// Seven things a real machine produces and nothing in the happy path anticipates. The bar is not
// that each is handled well — two of them are open defects — it is that the SERVER KEEPS ANSWERING
// and that the next reconcile repairs what can be repaired. Each case is checked for a log line as
// well, because a case that is swallowed silently is the one nobody ever fixes.
async function blockC2() {
  say('\n--- C.2-lite: empty file, no frontmatter, BOM+CRLF, a stranded .tmp, a truncated index, a corrupt stamp, a dead-pid lock');
  const sb = makeSandbox('C2');
  const SID = 'd1d2d3d4-1111-2222-3333-444455550041';
  const doc = (name, ts, body) =>
    `---\nname: ${name}\ndescription: "a campaign fixture"\nmetadata:\n  type: exchange\n  sessionId: ${SID}\n  sessionTitle: "campaign fixture"\n  ts: ${ts}\n---\n\n**Asked:** a campaign fixture\n\n${body}\n`;

  writeFileSync(join(sb.store, 'x-d1d2d3d4-20260901T010000000Z.md'),
    doc('x-d1d2d3d4-20260901T010000000Z', '2026-09-01T01:00:00.000Z',
      'A healthy exchange about truing a wheel and checking spoke tension, long enough to index cleanly.'));
  writeFileSync(join(sb.store, 'x-d1d2d3d4-20260901T020000000Z.md'), '');                       // EMPTY
  writeFileSync(join(sb.store, 'x-d1d2d3d4-20260901T030000000Z.md'),
    'no frontmatter at all, just a paragraph about the workshop rota and nothing else.\n');      // NO FRONTMATTER
  writeFileSync(join(sb.store, 'x-d1d2d3d4-20260901T040000000Z.md'),
    '﻿' + doc('x-d1d2d3d4-20260901T040000000Z', '2026-09-01T04:00:00.000Z',
      'A BOM and CRLF exchange about brake pad bedding procedure in the workshop.').replace(/\n/g, '\r\n'));  // BOM + CRLF
  writeFileSync(join(sb.store, 'x-d1d2d3d4-20260901T050000000Z.md.4242.tmp'), 'half a fi');      // STRANDED .tmp
  writeFileSync(join(sb.store, '.last-ingest.json'), '{"broken": ');                             // CORRUPT stamp
  writeFileSync(join(sb.env.MEMORY_TIMED_CAPTURE_LOCK), JSON.stringify({ pid: 999_999, at: new Date().toISOString() })); // DEAD-PID lock

  const buildOne = () => spawnSync(process.execPath, ['-e',
    "const C=await import(process.env.__CFG);const{buildIndex}=await import(process.env.__IDX);" +
    "const r=await buildIndex({force:true,dir:C.rootsForCorpus('staging'),out:C.stagingIndexPath()});console.log('indexed',r.filesIndexed,'docs',r.docCount??'');"],
  { env: { ...sb.env, __CFG: pathToFileURL(join(TREE, 'lib', 'config.js')).href, __IDX: pathToFileURL(join(TREE, 'lib', 'index-store.js')).href },
    cwd: TREE, encoding: 'utf8', windowsHide: true });

  const b1 = buildOne();
  record('C.2', 'the index builds over a store full of hostile files instead of throwing',
    b1.status === 0 && /indexed \d+/.test(String(b1.stdout)), { detail: String(b1.stdout || b1.stderr).slice(-300) });

  // TRUNCATE the built index — the header survives, the body does not.
  const whole = slurp(sb.staging);
  writeFileSync(sb.staging, whole.slice(0, Math.min(4096, Math.floor(whole.length / 2))));

  const srv = await connect(sb.env, { scheduler: false });
  const answers = {
    search: await srv.call({ action: 'search', query: 'truing a wheel and spoke tension', scope: 'staging', limit: 5 }),
    latest: await srv.call({ action: 'latest', scope: 'staging', limit: 8 }),
    sessions: await srv.call({ action: 'sessions', scope: 'staging', limit: 8 }),
    curated: await srv.call({ action: 'search', query: 'light oil on the pawls', scope: 'curated', limit: 3 })
  };
  record('C.2', 'THE ONE THAT MATTERS — the server answers every action over a truncated index',
    Object.values(answers).every((r) => !r.timeout && r.text.length > 0),
    { detail: Object.entries(answers).map(([k, r]) => `${k}:${r.timeout ? 'TIMEOUT' : r.bytes + 'b'}`).join(' ') });
  // 🟥 THE ASSERTION HAS TO BE ABOUT THE WORDS, not just about rows. A first draft accepted any
  // body containing the substring "index" and therefore passed on the note "no index for this
  // scope" — a message that is WRONG (there is an index; it is half a file) and that sends the
  // reader to rebuild something they think is missing. MEM-51 plus the MEM-59 wording.
  const c2note = String(answers.latest.body?.note || answers.latest.body?.error || '');
  const c2rows = rowsOf(answers.latest.body).length;
  record('C.2', '...and it does not go quiet: it returns rows or says outright that the index is behind',
    c2rows > 0 || answers.latest.body?.indexStale === true,
    { detail: `rows=${c2rows} indexStale=${answers.latest.body?.indexStale} note="${c2note.slice(0, 140)}"` });
  record('C.2', '...and it calls a CORRUPT index corrupt, not MISSING',
    c2rows > 0 || /corrupt|truncat|damaged|unreadable/i.test(c2note),
    { detail: `note="${c2note.slice(0, 140)}" — sends the reader to rebuild something they think is absent` });   // STRICT since MEM-75
  const stderrMid = srv.stderr();
  await srv.close();

  // THE RECONCILE: a fresh walk over the same wreckage.
  const walk = walkNow(sb, 'c2-reconcile');
  const log = walk.stdout + walk.stderr;
  record('C.2', 'a walk over the wreckage completes rather than dying', walk.status === 0,
    { detail: `status ${walk.status}; ${log.split('\n').filter(Boolean).slice(-3).join(' | ')}` });
  const rebuilt = slurp(sb.staging);
  let header = null; try { header = JSON.parse(rebuilt); } catch { /* still truncated */ }
  record('C.2', 'the next reconcile repairs the truncated index', header !== null,
    { detail: header ? `rebuilt, ${(header.docs || []).length} docs` : `still ${rebuilt.length} bytes of half a JSON file` });   // STRICT since MEM-75

  // The empty file: it must be NAMED somewhere rather than silently counted.
  const b2 = buildOne();
  const namedEmpty = /020000000Z/.test(String(b2.stdout + b2.stderr + log));
  record('C.2', 'the EMPTY store file is named in a log line rather than swallowed', namedEmpty,
    { detail: String(b2.stdout).trim().slice(-200) });   // STRICT since MEM-75

  // The reconcile does not repair it, but an EXPLICIT rebuild does — so the wreck is recoverable
  // by hand (`npm run index`) even while MEM-51 is open. `b2` above is that rebuild.
  const srv2 = await connect(sb.env, { scheduler: false });
  const after = await srv2.call({ action: 'search', query: 'truing a wheel and spoke tension', scope: 'staging', limit: 5 });
  record('C.2', 'an explicit rebuild recovers the corpus, so the wreck is not terminal',
    !after.timeout && rowsOf(after.body).length > 0, { detail: `${rowsOf(after.body).length} rows, ${after.bytes} bytes` });
  const stderrAll = stderrMid + srv2.stderr();
  record('C.2', 'no unhandled rejection through any of it',
    !/UnhandledPromiseRejection|Unhandled promise rejection/i.test(stderrAll), { detail: stderrAll.slice(-300) });
  record('C.2', 'the stranded .tmp did not become a document',
    !JSON.stringify(after.body || {}).includes('.tmp'), { detail: 'no .tmp name in any row' });
  await srv2.close();
  return { walkStatus: walk.status };
}

// =================================================================================================
// The driver
// =================================================================================================
const BLOCKS = { A: blockA, B1: blockB1, B3: blockB3, B4: blockB4, C2: blockC2 };

/**
 * @param {object} [o]
 * @param {(name:string, ok:boolean, detail?:string)=>void} [o.check]  the public suite's reporter
 * @param {(t:string)=>void} [o.group]
 */
export async function campaignLite({ check = null, group = null } = {}) {
  OUTER = check;
  ROWS.length = 0; knownFired.clear(); knownAsked.clear();
  if (group) group('campaign-lite — A / B.1 / B.3 / B.4 / C.2, sandboxed');

  const only = String(process.env.MEMORY_CAMPAIGN_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = Object.keys(BLOCKS).filter((k) => (only.length ? only.includes(k) : true));
  const drift = redirectsDrift();
  record('setup', 'the inlined REDIRECTS list still matches test/sandbox-env.js', drift === null,
    { detail: drift || 'identical (or a release tree, where sandbox-env.js does not ship)' });
  record('setup', 'the gold-corpus fixtures are present', mdFiles(GOLD).length > 0, { detail: `${mdFiles(GOLD).length} files` });

  const t0 = Date.now();
  const summary = {};
  for (const id of chosen) {
    const t = Date.now();
    try { summary[id] = await BLOCKS[id](); }
    catch (e) {
      record(id, 'the block ran to completion', false, { detail: `THREW: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)}` });
    }
    summary[`${id}_sec`] = Math.round((Date.now() - t) / 1000);
    say(`    ${id} finished in ${summary[`${id}_sec`]}s`);
  }
  for (const srv of [...SERVERS]) { try { await srv.close(); } catch { /* already gone */ } }
  await sleep(500);                                      // let taskkill /T finish before the rm
  // MEM-69: retry the removal (a scanner or a lagging handle makes EBUSY transient on Windows) and
  // never let it end the run — the table below is what this file is for.
  for (const d of SANDBOXES.splice(0)) cleanupSandbox(d, { label: 'campaign-lite', log: say });

  // ---- the table --------------------------------------------------------------------------
  const failed = ROWS.filter((r) => r.status === 'FAIL');
  const known = ROWS.filter((r) => r.status.startsWith('KNOWN-'));
  const unfired = [...knownAsked].filter((k) => !knownFired.has(k) && !OPPORTUNISTIC.has(k));
  const quietRaces = [...knownAsked].filter((k) => !knownFired.has(k) && OPPORTUNISTIC.has(k));
  const wall = Math.round((Date.now() - t0) / 1000);

  say('\n=== campaign-lite: per-block table ===');
  say(`${'block'.padEnd(6)}${'status'.padEnd(20)}assertion`);
  for (const r of ROWS) say(`${r.block.padEnd(6)}${r.status.padEnd(20)}${r.name}`);
  say(`\n${ROWS.length - failed.length - known.length} PASS, ${known.length} KNOWN, ${failed.length} FAIL  (${wall}s wall, ${process.platform}/${process.arch}, node ${process.version})`);
  for (const [k, v] of Object.entries(summary)) if (v && typeof v === 'object') say(`  ${k}: ${JSON.stringify(v)}`);
  if (known.length) {
    say('\nKNOWN defects that FIRED — the test can see them, and will turn strict when the fix merges:');
    for (const k of [...knownFired].sort()) say(`  ${k}  ${KNOWN[k]}`);
  }
  if (quietRaces.length) {
    say('\nRace-dependent KNOWN defects that did not happen to fire this run (not an alarm):');
    for (const k of quietRaces.sort()) say(`  ${k}  ${KNOWN[k]}`);
  }
  if (unfired.length) {
    say('\n🟥 KNOWN markers that did NOT fire. Either the fix has landed (delete the marker) or the');
    say('   assertion is too weak to see the defect. Both need somebody to look:');
    for (const k of unfired.sort()) say(`  ${k}  ${KNOWN[k]}`);
  }
  if (failed.length) {
    say('\nFAILURES:');
    for (const r of failed) say(`  [${r.block}] ${r.name}\n      ${r.detail}`);
  }

  const outDir = process.env.MEMORY_CAMPAIGN_OUT;
  if (outDir) {
    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `campaign-lite-${process.platform}.json`),
        JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
          wallSec: wall, rows: ROWS, summary, knownFired: [...knownFired], knownUnfired: unfired,
          knownQuietRaces: quietRaces }, null, 2));
    } catch (e) { say(`  (could not write the JSON report: ${e.message})`); }
  }
  return { rows: ROWS, failed: failed.length, known: known.length, unfired, wall };
}

// Standalone: `node test/public/campaign-lite.mjs`. Exit non-zero only on FAIL — a KNOWN is a
// reported defect somebody is already fixing, not a broken build.
// realpath + lowercase: a Windows argv[1] differs from import.meta.url in drive-letter case and in
// whether the path went through a junction, and a mismatch here would silently make the file a
// no-op when run directly — which is how it runs in CI.
const same = (a, b) => { try { return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase(); } catch { return false; } };
const invokedDirectly = !!process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const r = await campaignLite();
  process.exit(r.failed ? 1 : 0);
}
