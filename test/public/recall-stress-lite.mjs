// test/public/recall-stress-lite.mjs — the shippable third of the recall stress harness.
//
// THE PRIVATE HARNESS (test/recall-stress/) runs eighteen fault scenarios against two trees and
// takes ten minutes. It does not ship, and not only for time: it asserts against the author's
// own release layout. This is the part that holds on any machine — one conversation, three
// questions, and the one property that matters:
//
//     A QUERY MAY BE WRONG. IT MAY NOT BE CONFIDENTLY WRONG.
//
// Three situations, in the order they hurt:
//
//   A  steady state          the hook completes, the newest exchange comes back. Gated.
//   B  killed mid-way        the writer is SIGKILLed after the extractor wrote its files and
//                            before the index was rebuilt — the real shape of the 2026-09-05
//                            incident. The answer no longer CONTAINS the exchange, so it has to
//                            NAME it: `foundInUnindexed`, `recencyVoid.unreadFiles`, or
//                            `staleFilesAdded`. Gated.
//   C  the machine slept     the transcript grew while nothing was capturing. Today nothing
//                            reports this; the check is written so that it passes both now and
//                            once a channel exists, and the observation is printed either way.
//
//   D  determinism           two ranking snapshots of the same corpus must be byte-identical.
//                            An unfrozen clock or an unstable corpus label would make the real
//                            gate meaningless, so the gate's own premise is tested here.
//
// The kill is done from OUTSIDE, by killing the child's whole process tree. There is deliberately
// no seam in the production code for it — a fault-injection hook that ships is a fault-injection
// hook an attacker or an accident can reach.
//
// 🟥 AND IT HAS TO BE THE TREE, NOT THE GROUP (2026-09-05). This file used to SIGKILL a negative
// pid, which is a POSIX process group and does not exist on Windows: the kill threw, nothing died,
// and scenario B observed a run that completed normally. It did not fail — it stopped being a
// fault, quietly, on the one platform where this suite is the only capture test there is. The
// platform difference now lives in ./kill-tree.mjs, in one place, for both harnesses.
//
// No absolute paths anywhere in this file: it is rooted from its own location, because the
// public tree puts it somewhere else and a hardcoded path also carries a username.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killTreeMarked, spawnOptsForKill, IS_WINDOWS } from './kill-tree.mjs';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(dirname(HERE));                 // repo root, derived — never written down

const SEED = 4242;                                   // fixed: the same bytes on every machine
const TOPIC = `RCLTOPIC${SEED}`;
const SID = 'c0ffee12-3456-4789-abcd-ef0123456789';  // 8 leading hex chars, no hyphen: the
                                                     // extractor refuses any other name shape

const WORDS = ['spoke', 'rim', 'hub', 'caliper', 'grease', 'freehub', 'tension', 'truing',
  'valve', 'tape', 'pawl', 'bearing', 'cassette', 'chain', 'derailleur'];

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

/** A transcript of `n` exchanges. Every reply clears the extractor's 200-character floor. */
function writeTranscript(path, n, startMs) {
  const rnd = lcg(SEED);
  let clock = startMs;
  const tick = (ms) => { clock += ms; return new Date(clock).toISOString(); };
  const prose = (min, salt) => {
    let out = '', i = 0;
    while (out.length < min) {
      const k = 8 + Math.floor(rnd() * 8);
      out += Array.from({ length: k }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ') + ` for ${salt} pass ${i++}. `;
    }
    return out.trim();
  };
  const line = (o) => appendFileSync(path, JSON.stringify(o) + '\n', 'utf8');
  const written = [];
  for (let i = 1; i <= n; i++) {
    const token = `RCL-${SEED}-${String(i).padStart(3, '0')}`;
    const askTs = tick(1500);
    line({ type: 'user', timestamp: askTs, message: { role: 'user', content: `Please write up what we settled about ${TOPIC} and file it under ${token}. ${prose(100, token)}` } });
    line({ type: 'assistant', timestamp: tick(400), message: { role: 'assistant', content: [{ type: 'text', text: `Settled for ${token}: ${prose(650, `${TOPIC} ${token}`)}` }] } });
    written.push({ token, name: `x-${SID.slice(0, 8)}-${askTs.replace(/[-:.]/g, '')}` });
  }
  line({ type: 'user', timestamp: tick(500), message: { role: 'user', content: 'thanks that is all for now' } });
  return { written, clock };
}

const mdCount = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')).length : 0);

/**
 * Run the capture script in its own process group and, when `killAfter` files have appeared in
 * the store, SIGKILL the group. That lands between the extractor's last write and buildIndex.
 * Verified afterwards from the run log: SIGKILL runs no exit handler, so auto-ingest.js leaves
 * `started` with no terminal line, and nothing else in the system produces that.
 */
function capture(env, args, { killAfter = null, store = null } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env, cwd: TREE, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptsForKill() });
    let err = '', killed = false, mark = null;
    child.stderr.on('data', (d) => { err += d; });
    let timer = null;
    if (killAfter !== null) {
      timer = setInterval(() => {
        if (killed || mdCount(store) < killAfter) return;
        if (/refreshing staging index/.test(err)) return;    // too late: the build already began
        killed = true;
        mark = killTreeMarked(child, 'B');
      }, 2);
    }
    child.on('close', (code, signal) => { if (timer) clearInterval(timer); res({ code, signal, err, killed, mark, pid: child.pid }); });
  });
}

/**
 * Did THIS run die because we killed it? (MEM-63 — the same question `test/recall-stress/
 * scheduler.mjs verifyFault` asks, in the same platform-shaped way, because the private harness
 * getting it right and the shipped one getting it wrong is how six Windows scenarios went vacuous.)
 * Windows has no signals, so the marker is the proof there; POSIX keeps the signal and accepts
 * the marker too.
 */
const killLanded = (r) => (IS_WINDOWS
  ? !!(r.mark && r.mark.killed && r.mark.gone && r.code !== 0)
  : r.signal === 'SIGKILL' || !!(r.mark && r.mark.killed && r.code !== 0));

/** Every pid the run log shows as `started` with no terminal line — SIGKILL runs no exit handler. */
const crashedPids = (store) => {
  const p = join(store, '.ingest-runs.jsonl');
  if (!existsSync(p)) return [];
  const byPid = new Map();
  for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const e = byPid.get(o.pid) || { started: false, terminal: false };
    if (o.outcome === 'started') e.started = true; else e.terminal = true;
    byPid.set(o.pid, e);
  }
  return [...byPid.entries()].filter(([, e]) => e.started && !e.terminal).map(([pid]) => pid);
};

/** Ask the real MCP handler, in a fresh process, and hand back the parsed response. */
function ask(env, args) {
  const src = `
    const m = await import(${JSON.stringify(pathToFileURL(join(TREE, 'tools', 'memory.js')).href)});
    const c = new Map(); m.registerMemoryTools({ tool: (n, d, s, h) => c.set(n, h) });
    const r = await c.get('memory')(${JSON.stringify(args)});
    process.stdout.write('@@' + JSON.stringify(JSON.parse(r.content[0].text)) + '@@');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src],
    { env, cwd: TREE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const m = /@@([\s\S]*)@@/.exec(r.stdout || '');
  return m ? JSON.parse(m[1]) : { __nores: String(r.stderr).slice(-300) };
}

const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const rowsOf = (b) => [...arr(b?.results), ...arr(b?.sections).flatMap((s) => arr(s.results))];
const contains = (b, name) => rowsOf(b).some((r) => r && r.name === name);
function names(b, name) {
  const hits = [];
  if (arr(b?.recencyVoid?.unreadFiles).some((f) => String(f).includes(name))) hits.push('recencyVoid.unreadFiles');
  if (b?.foundInUnindexed && Object.values(b.foundInUnindexed).some((v) => arr(v).some((f) => String(f).includes(name)))) hits.push('foundInUnindexed');
  for (const k of ['staleFilesAdded', 'staleFilesChanged']) if (arr(b?.[k]).some((f) => String(f).includes(name))) hits.push(k);
  if (arr(b?.recentUnindexed?.files).some((f) => String(f?.file || f).includes(name))) hits.push('recentUnindexed');
  return hits;
}

// Twelve queries, enough to cover both actions, both scopes and an absence control. The full
// 46-query list and its committed baseline are private, because a query list is a vocabulary.
const LITE_QUERIES = [
  { id: 'l01', action: 'search', query: 'light oil on the pawls heavy grease on the bearing' },
  { id: 'l02', action: 'search', query: 'how do I bleed the hydraulic disc brakes' },
  { id: 'l03', action: 'search', query: 'who is allowed to sign off a bike before it goes on sale' },
  { id: 'l04', action: 'search', query: 'which tubeless sealant do we stock and why did we change' },
  { id: 'l05', action: 'search', query: 'what is the airport parking policy for staff cars' },
  { id: 'l06', action: 'search', query: 'how do I reset the payroll system password' },
  { id: 'l07', action: 'latest', query: 'sealant', scope: 'staging' },
  { id: 'l08', action: 'latest', query: 'freehub', scope: 'staging' },
  { id: 'l09', action: 'latest', query: 'chainwaxer', scope: 'staging' },
  { id: 'l10', action: 'search', query: 'grease', scope: ['curated', 'staging'] },
  { id: 'l11', action: 'latest', query: 'pawls', scope: 'all' },
  { id: 'l12', action: 'search', query: 're-face the dropouts if the axle binds' }
];

/**
 * @param {object} o
 * @param {(name:string, ok:boolean, detail?:string)=>void} o.check
 * @param {(t:string)=>void} o.group
 * @param {(extra?:object)=>{dir:string, env:object}} o.sandbox   from run-public-tests.js
 */
export async function recallStressLite({ check, group, sandbox }) {
  group('recent recall under fault — a query may be wrong, but never confidently wrong');

  const sb = sandbox({
    MEMORY_AUTO_INGEST: 'always',            // no heartbeat exists in a sandbox
    MEMORY_INGEST_DEBOUNCE_SEC: '0',
    MEMORY_FRESHNESS_TTL_MS: '0',            // every query re-stats; the cache is not the subject
    MEMORY_GIT_REPOS: '',
    MEMORY_ACCOUNT: 'lite-fixture',
    MEMORY_ALL_PROJECTS: '0',
    MEMORY_LIBRARY: '0'
  });
  const store = sb.env.MEMORY_OWN_STORE;
  const projects = join(sb.env.HOME, '.claude', 'projects', 'p-lite');
  mkdirSync(projects, { recursive: true });
  const tx = join(projects, `${SID}.jsonl`);
  writeFileSync(tx, '');

  // ---- A: steady state ------------------------------------------------------------------
  const first = writeTranscript(tx, 12, Date.UTC(2026, 8, 5, 6, 0, 0));
  await capture(sb.env, [join(TREE, 'scripts', 'auto-ingest.js'), tx]);
  const steadyTarget = first.written[11];
  const a = ask(sb.env, { action: 'latest', query: steadyTarget.token, scope: 'staging' });
  check('A: after a completed capture, the newest exchange is returned',
    contains(a, steadyTarget.name), JSON.stringify({ rows: rowsOf(a).length, note: String(a.note || a.__nores).slice(0, 90) }));
  check('A: ...and 12 exchanges reached the store', mdCount(store) === 12, `store holds ${mdCount(store)}`);

  // ---- B: killed between the write and the index -------------------------------------------
  const more = writeTranscript(tx, 3, Date.UTC(2026, 8, 5, 8, 0, 0));
  const killTarget = more.written[2];
  const before = mdCount(store);
  let armed = false, why = 'never attempted';
  for (let attempt = 0; attempt < 3 && !armed; attempt++) {
    const r = await capture(sb.env, [join(TREE, 'scripts', 'auto-ingest.js'), tx], { killAfter: before + 3, store });
    const landed = killLanded(r);
    // 🟥 THIS run's pid, not "some pid": crashedPids scans the whole log, so a retry would
    // otherwise inherit the previous attempt's started-without-terminal line and read a clean
    // completion as a kill. auto-ingest.js logs its own process.pid, which is the child's.
    const sig = crashedPids(store).includes(r.pid);
    armed = mdCount(store) >= before + 3 && landed && sig;
    why = JSON.stringify({ store: `${before} -> ${mdCount(store)}`, killIssued: !!(r.mark && r.mark.killed),
      how: r.mark ? r.mark.how : null, treeGone: r.mark ? r.mark.gone : null, code: r.code, signal: r.signal,
      killLanded: landed, crashSignatureForPid: sig });
  }
  // A fault that did not fire is not evidence. Say so rather than passing on a fault-free run.
  check('B: the writer really was killed after its files landed and before the index was built',
    armed, why);
  if (armed) {
    const b = ask(sb.env, { action: 'latest', query: killTarget.token, scope: 'staging' });
    const named = names(b, killTarget.name);
    check('B: the answer NAMES the exchange its index has not read',
      contains(b, killTarget.name) || named.length > 0,
      JSON.stringify({ rows: rowsOf(b).length, named, stale: b.indexStale, note: String(b.note || '').slice(0, 90) }));
    const b2 = ask(sb.env, { action: 'latest', query: TOPIC, scope: 'staging' });
    check('B: ...and a query that DOES rank older rows says results[0] is not the last word',
      contains(b2, killTarget.name) || names(b2, killTarget.name).length > 0 || !!b2.recencyVoid,
      JSON.stringify({ rows: rowsOf(b2).length, recencyVoid: !!b2.recencyVoid }));
  }

  // ---- C: the machine slept ------------------------------------------------------------------
  const slept = writeTranscript(tx, 2, Date.UTC(2026, 8, 5, 10, 0, 0));
  const sleptTarget = slept.written[1];
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(tx, old, old);                            // twenty minutes: outside the walker window
  await capture(sb.env, [join(TREE, 'scripts', 'timed-capture.mjs')]);
  const c = ask(sb.env, { action: 'latest', query: sleptTarget.token, scope: 'staging' });
  const inStore = existsSync(join(store, `${sleptTarget.name}.md`));
  const cNamed = names(c, sleptTarget.name);
  // A-D5: `uncapturedSessions` is an OBJECT ({count, sessions:[…]}), not an array — `arr()` wrapped
  // it as a one-element list, so this line read "named" for a stamp that named nobody, and would
  // have read the same for `count: 0`. Ask the shape what it actually says.
  const uncapturedRows = (u) => (!u ? [] : Array.isArray(u) ? u : Array.isArray(u.sessions) ? u.sessions : [u]);
  const uncaptured = uncapturedRows(c.uncapturedSessions).length > 0;
  // Passes today (the exchange is genuinely absent from the store) and passes once a channel
  // reports it. What it refuses is the middle case: the file exists, is not returned, and
  // nothing says so.
  check('C: a session the walker could not reach is never answered as though it were current',
    contains(c, sleptTarget.name) || cNamed.length > 0 || !inStore,
    JSON.stringify({ inStore, named: cNamed, rows: rowsOf(c).length }));
  check(`C: (REPORTED, not gated) an exchange that exists only in the transcript is ` +
    `${uncaptured ? 'NAMED by uncapturedSessions' : 'reported by NO channel — the WP3b gap'}`, true);

  // ---- D: the ranking gate's own premise ------------------------------------------------------
  const qFile = join(sb.dir, 'lite-queries.json');
  writeFileSync(qFile, JSON.stringify(LITE_QUERIES, null, 2));
  const snap = (out) => spawnSync(process.execPath,
    [join(TREE, 'scripts', 'ranking-snapshot.mjs'), '--corpus', 'gold', '--queries', qFile,
      '--sandbox', join(sb.dir, 'snap-corpus'), '--out', out],
    { env: { ...sb.env, MEMORY_QUERY_LOG: '0' }, cwd: TREE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const s1 = snap(join(sb.dir, 'snap-a.json'));
  const s2 = snap(join(sb.dir, 'snap-b.json'));
  check('D: the ranking snapshot runs against the gold fixtures',
    s1.status === 0 && s2.status === 0 && existsSync(join(sb.dir, 'snap-b.json')),
    String(s1.stderr || s2.stderr).slice(-200));
  if (s1.status === 0 && s2.status === 0) {
    const cmp = spawnSync(process.execPath,
      [join(TREE, 'scripts', 'ranking-snapshot.mjs'), '--compare', join(sb.dir, 'snap-a.json'), join(sb.dir, 'snap-b.json')],
      { env: sb.env, cwd: TREE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    check('D: two snapshots of the same corpus are byte-identical (frozen clock, stable labels)',
      cmp.status === 0, String(cmp.stdout || '').slice(0, 300));
  }

  // MEM-69: this file killed capture trees and then left its sandbox behind entirely — every run
  // leaked a temp tree. Removed with the Windows retry, and a failure only warns.
  cleanupSandbox(sb.dir, { label: 'recall-stress-lite' });
}
