// test/public/store-audit-tick.mjs — DOES THE AUDIT SEE A LIE, AND DOES IT REFUSE TO SEE A GHOST?
//
// The public half of (a84). Two checks, and they are the two that make a detector worth having:
//
//   THE ALARM    a planted MEM-39 — a session's store files deleted while store/.last-ingest.json
//                still claims the transcript was captured at full size — is FOUND (`audit-alarm`,
//                missingStale = 2), REPAIRED (`audit-healed`), and the repaired files exist.
//   THE CONTROL  a session whose only gap is the exchange still being written is `missing:1,
//                missingStale:0, outcome:'audit'` — no alarm and no repair. Without this the
//                detector fires on every healthy machine, once an hour, forever, and gets muted.
//
// 🟥 WHY IT IS IN THE PUBLIC SUITE. It runs on windows-latest, and three of the things it exercises
// were platform-specific defects in the last release: the sandbox needs USERPROFILE as well as HOME
// (MEM-38 #3), the store write ends in a rename that Windows can refuse (MEM-38 #1), and a spawned
// walker/extractor chain must be killed as a TREE (MEM-38 #2, test/public/kill-tree.mjs). Nothing
// here reads an absolute path from this machine, and nothing outside its own temp directory.

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnOptsForKill } from './kill-tree.mjs';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(dirname(HERE));                       // repo root, derived — never written down

const u = (t, ts) => JSON.stringify({ type: 'user', message: { role: 'user', content: t }, timestamp: ts });
const a = (t, ts) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, timestamp: ts });
const long = (w) => (w + ' ').repeat(60).trim();
const mdFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')) : []);

export async function storeAuditTick({ check, group }) {
  group('the store audit — an exchange stamped as captured and missing is found, and repaired');

  const dir = mkdtempSync(join(tmpdir(), 'recall-audit-'));
  const projects = join(dir, '.claude', 'projects', 'proj');
  const store = join(dir, 'store');
  const runLog = join(dir, 'runs.jsonl');
  mkdirSync(projects, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(join(dir, 'mem'), { recursive: true });

  // Every writable path inside `dir`, and BOTH home variables: os.homedir() reads HOME on POSIX and
  // USERPROFILE on Windows, so a sandbox that sets only the first is not a sandbox on windows-latest.
  const env = (extra = {}) => ({
    ...process.env,
    HOME: dir, USERPROFILE: dir,
    MEMORY_DIR: join(dir, 'mem'),
    MEMORY_OWN_STORE: store,
    MEMORY_INDEX: join(dir, 'curated.json'),
    MEMORY_STAGING_INDEX: join(dir, 'staging.json'),
    MEMORY_HANDOFF_INDEX: '0',
    MEMORY_PROJECTS_INDEX: '0',
    MEMORY_LIBRARY: '0',
    MEMORY_INGEST_LOG: runLog,
    MEMORY_VANISH_LOG: join(dir, 'vanish.jsonl'),
    MEMORY_QUERY_LOG: '0',
    MEMORY_GIT_REPOS: '',
    MEMORY_MODEL_CACHE: join(TREE, '.model-cache'),
    MEMORY_STORE_AUDIT_STAMP: join(dir, 'audit-last.json'),
    MEMORY_STORE_AUDIT_LOCK: join(dir, 'audit.lock'),
    MEMORY_TIMED_CAPTURE_LOCK: join(dir, 'walk.lock'),
    MEMORY_TIMED_CAPTURE_STAMP: join(dir, 'walk-last.json'),
    MEMORY_STORE_SNAPSHOT_DIR: join(dir, 'snapshots'),
    MEMORY_STORE_SNAPSHOT_HOURS: '0',                       // the snapshot has its own checks
    MEMORY_ACCOUNT: 'public-test-account',   // not an address: the release gate refuses any email in shipped source
    ...extra
  });

  // Two sessions, both finished: nothing is inside the 15-minute grace window.
  const SID = { done: 'aaaa5150-1111-2222-3333-444455556666', live: 'bbbb5150-1111-2222-3333-444455556666' };
  const OLD = '2026-09-05T10:';
  const txOf = (sid) => join(projects, `${sid}.jsonl`);
  writeFileSync(txOf(SID.done), [
    u('how do I true a wheel', `${OLD}00:00Z`), a(long('Find the high spot with the caliper first'), `${OLD}00:10Z`),
    u('and the tyre pressure', `${OLD}05:00Z`), a(long('Eighty psi on the rear and seventy five on the front'), `${OLD}05:10Z`)
  ].join('\n') + '\n');
  const nowIso = () => new Date().toISOString();
  writeFileSync(txOf(SID.live), [
    u('what chain wear limit do we use', `${OLD}00:00Z`), a(long('Zero point seven five percent stretch on eleven speed'), `${OLD}00:10Z`),
    u('and for twelve speed', nowIso()), a(long('The same checker reads twelve speed chains as well'), nowIso())
  ].join('\n') + '\n');

  const capture = (sid) => spawnSync(process.execPath, [join(TREE, 'scripts', 'ingest-transcript.js'), txOf(sid), '--write'],
    { encoding: 'utf8', cwd: TREE, env: env(), windowsHide: true });
  capture(SID.done); capture(SID.live);
  check('two fixture transcripts captured into a sandbox store', mdFiles(store).length === 4, String(mdFiles(store).length));

  const tick = (extra = {}) => spawnSync(process.execPath, [join(TREE, 'scripts', 'store-audit-tick.mjs')],
    { encoding: 'utf8', cwd: TREE, env: env(extra), windowsHide: true });
  const auditRows = () => (existsSync(runLog) ? readFileSync(runLog, 'utf8').split('\n') : [])
    .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && String(r.outcome || '').startsWith('audit'));

  // ---- THE CONTROL, FIRST -----------------------------------------------------------------------
  // The live session's last exchange was written seconds ago and its file is deliberately absent.
  const liveFiles = mdFiles(store).filter((f) => f.startsWith(`x-${SID.live.slice(0, 8)}-`)).sort();
  rmSync(join(store, liveFiles[liveFiles.length - 1]));
  const control = tick();
  const controlRow = auditRows().pop();
  check('CONTROL — an exchange written seconds ago is `missing` but NOT an alarm',
    controlRow?.outcome === 'audit' && controlRow.missing === 1 && controlRow.missingStale === 0,
    JSON.stringify(controlRow) + ` exit=${control.status} ${String(control.stderr || '').slice(0, 200)}`);
  check('...so a healthy machine is not told anything, and nothing is rewritten',
    (controlRow?.healed || []).length === 0 && !auditRows().some((r) => r.outcome === 'audit-alarm'));

  // ---- THE ALARM AND THE REPAIR -----------------------------------------------------------------
  // MEM-39 exactly: the files are gone and the debounce stamp still claims a full capture, so a real
  // capture would look at the stamp and skip. The audit reads the transcript instead.
  const doomed = mdFiles(store).filter((f) => f.startsWith(`x-${SID.done.slice(0, 8)}-`)).sort();
  for (const f of doomed) rmSync(join(store, f));
  writeFileSync(join(store, '.last-ingest.json'),
    JSON.stringify({ [txOf(SID.done)]: { at: Date.now(), size: statSync(txOf(SID.done)).size } }, null, 2) + '\n');

  const reportOnly = tick({ MEMORY_STORE_AUDIT_HEAL: '0' });
  const alarm = auditRows().pop();
  check('THE ALARM — two exchanges stamped as captured and long absent are audit-alarm',
    alarm?.outcome === 'audit-alarm' && alarm.missingStale === 2,
    JSON.stringify(alarm) + ` exit=${reportOnly.status} ${String(reportOnly.stderr || '').slice(0, 300)}`);
  check('...and MEMORY_STORE_AUDIT_HEAL=0 changes nothing on disk',
    mdFiles(store).filter((f) => f.startsWith(`x-${SID.done.slice(0, 8)}-`)).length === 0);

  const healed = tick();
  const healRow = auditRows().pop();
  check('THE REPAIR — the tick re-runs the extractor with the stamp ignored and both files come back',
    healRow?.outcome === 'audit-healed' && healRow.wrote === 2 &&
    doomed.every((f) => existsSync(join(store, f))),
    JSON.stringify(healRow) + ` exit=${healed.status} ${String(healed.stderr || '').slice(0, 300)}`);
  // Two alarms by now: the report-only pass raised one and the repairing pass raised its own before
  // fixing anything. Both stay. A repaired fault that leaves no trace is a fault that gets to
  // happen again unobserved.
  check('...and the alarm rows are still in the log, before the heal — a repaired fault leaves a trace',
    auditRows().filter((r) => r.outcome === 'audit-alarm').length === 2 &&
    auditRows().findIndex((r) => r.outcome === 'audit-healed') > auditRows().findIndex((r) => r.outcome === 'audit-alarm'),
    JSON.stringify(auditRows().map((r) => r.outcome)));

  // ---- captureHealth says it out loud ------------------------------------------------------------
  const health = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { captureHealth } = await import(process.env.HEALTH_MODULE);
    process.stdout.write('@@' + JSON.stringify(captureHealth()) + '@@');`],
    { encoding: 'utf8', cwd: TREE, env: env({ HEALTH_MODULE: new URL('../../lib/ingest-health.js', import.meta.url).href }), windowsHide: true });
  const h = (() => { try { return JSON.parse(/@@([\s\S]*)@@/.exec(health.stdout || '')[1]); } catch { return null; } })();
  check('captureHealth carries the audit to the reader — what was found, and that it was repaired',
    h && h.healthy === false && h.audit?.outcome === 'audit-healed' && h.audit.healed === 2 &&
    /repaired at /.test(String(h.note)),
    JSON.stringify(h) + String(health.stderr || '').slice(0, 200));

  // ---- THE LOCK ----------------------------------------------------------------------------------
  // A capture walk in progress means the store is being written; reading it then produces `missing`
  // rows that are neither true nor false. Held by a LIVE pid — a real child, killed as a TREE
  // afterwards, because on Windows the POSIX process-group kill is a silent no-op (MEM-38 #2).
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'],
    { stdio: 'ignore', windowsHide: true, ...spawnOptsForKill() });
  writeFileSync(join(dir, 'walk.lock'), String(holder.pid));
  const blocked = tick();
  const blockedRow = auditRows().pop();
  check('a capture walk holding the lock makes the audit skip rather than read a store being written',
    blockedRow?.outcome === 'audit-skipped' && blockedRow.why === 'lock held',
    JSON.stringify(blockedRow) + ` exit=${blocked.status}`);
  // MEM-69: killTree ISSUES the kill; awaiting the child's exit is what makes the sandbox
  // deletable afterwards on Windows. The lock file itself is inside the sandbox either way.
  await stopChild(holder);
  rmSync(join(dir, 'walk.lock'), { force: true });

  // ---- THE KILL SWITCH ---------------------------------------------------------------------------
  const before = auditRows().length;
  const offRun = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const S = await import(process.env.SCHED_MODULE);
    const stop = S.startScheduler({ intervalSec: 300, tickMs: 40, log: () => {} });
    await new Promise((r) => setTimeout(r, 400)); stop();
    process.stdout.write('@@' + JSON.stringify({ interval: S.auditIntervalSec() }) + '@@');`],
    { encoding: 'utf8', cwd: TREE, windowsHide: true,
      env: env({ MEMORY_STORE_AUDIT_MIN: '0', MEMORY_SCHEDULER: '0', SCHED_MODULE: new URL('../../lib/scheduler.js', import.meta.url).href }) });
  check('MEMORY_STORE_AUDIT_MIN=0 turns the audit off entirely — no interval, and no row',
    /"interval":0/.test(offRun.stdout || '') && auditRows().length === before,
    `${String(offRun.stdout || '').slice(0, 60)} rows ${before}->${auditRows().length}`);

  // ---- THE DAILY SNAPSHOT AND ITS RESTORE ---------------------------------------------------------
  group('the daily store snapshot — the transcript is the backup until the transcript is pruned');
  const snap = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const S = await import(process.env.SNAP_MODULE);
    const store = process.env.MEMORY_OWN_STORE;
    const dir = process.env.MEMORY_STORE_SNAPSHOT_DIR;
    const one = S.snapshotStore({ store, dir, now: Date.parse('2026-09-05T02:00:00Z'), hours: 24 });
    const same = S.snapshotStore({ store, dir, now: Date.parse('2026-09-06T02:00:00Z'), hours: 24 });
    process.stdout.write('@@' + JSON.stringify({ one, same, have: S.listSnapshots(dir) }) + '@@');`],
    { encoding: 'utf8', cwd: TREE, env: env({ SNAP_MODULE: new URL('../../lib/store-snapshot.js', import.meta.url).href }), windowsHide: true });
  const s = (() => { try { return JSON.parse(/@@([\s\S]*)@@/.exec(snap.stdout || '')[1]); } catch { return null; } })();
  check('one gzipped JSONL a day, holding every file in the store',
    s && s.one.wrote === true && s.one.files === mdFiles(store).length && s.one.bytes > 0,
    JSON.stringify(s?.one) + String(snap.stderr || '').slice(0, 200));
  check('...and an UNCHANGED store is skipped, so idle days cannot evict real ones',
    s && s.same.wrote === false && /unchanged/.test(s.same.why), JSON.stringify(s?.same));

  const victim = mdFiles(store).sort()[0];
  const body = readFileSync(join(store, victim), 'utf8');
  rmSync(join(store, victim));
  const restore = spawnSync(process.execPath, [join(TREE, 'scripts', 'store-restore.mjs'),
    join(dir, 'snapshots', s.have[0])], { encoding: 'utf8', cwd: TREE, env: env(), windowsHide: true });
  check('store-restore.mjs puts a deleted file back, byte for byte',
    existsSync(join(store, victim)) && readFileSync(join(store, victim), 'utf8') === body,
    String(restore.stdout || '').slice(0, 200) + String(restore.stderr || '').slice(0, 200));
  writeFileSync(join(store, victim), 'EDITED SINCE THE SNAPSHOT');
  const second = spawnSync(process.execPath, [join(TREE, 'scripts', 'store-restore.mjs'),
    join(dir, 'snapshots', s.have[0])], { encoding: 'utf8', cwd: TREE, env: env(), windowsHide: true });
  check('...and REFUSES to overwrite what is already there — a partial loss must not become a total one',
    readFileSync(join(store, victim), 'utf8') === 'EDITED SINCE THE SNAPSHOT' && /already in the store/.test(second.stdout || ''),
    String(second.stdout || '').slice(0, 200));

  cleanupSandbox(dir, { label: 'store-audit-tick' });   // MEM-69: cleanup is never an assertion
}
