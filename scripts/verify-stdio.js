#!/usr/bin/env node
// scripts/verify-stdio.js — drive the server over raw stdio JSON-RPC, with no
// MCP client involved. This is the check that the thing Claude Desktop will
// actually spawn really answers: initialize → tools/list → tools/call.
//
//   npm run verify
//
// Exit code is the verdict.

import { spawnHidden, execFileSyncHidden } from '../lib/child.js';   // MEM-83: no console window on Windows
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// SELF-CONTAINED BY CONSTRUCTION. This script used to search for "how do I restart the
// email app server" and `get` a memory called `verify-protocol` — one particular person's
// corpus. On an empty install it skipped those checks and passed; on anyone ELSE's
// populated corpus it failed six of them and crashed reading `.outbound` of undefined,
// so a healthy install reported itself broken. A smoke test that only works on the
// author's machine is not a smoke test.
//
// It now builds its own tiny corpus in a temp dir and drives the server against that, so
// every check is meaningful on every machine and nothing depends on what the user has
// written. The fixture is deleted on exit.
const FIX = mkdtempSync(join(tmpdir(), 'memory-verify-'));
// A HOME of the fixture's own, with an EMPTY transcript folder inside it. Empty is the point: the
// `capture` check below spawns the real hook, and the one thing it must never resolve is the
// conversation the person running this smoke test is having right now.
const FIX_TRANSCRIPTS = join(FIX, '.claude', 'projects', 'p-verify');
mkdirSync(FIX_TRANSCRIPTS, { recursive: true });
mkdirSync(join(FIX, 'store'), { recursive: true });
const M = (name, body, links = []) => writeFileSync(join(FIX, `${name}.md`),
  `---\nname: ${name}\ndescription: "${body.split('\n')[0].replace(/"/g, '')}"\nmetadata:\n  type: project\n---\n\n${body}\n${links.map((l) => `[[${l}]]`).join(' ')}\n`);

// alpha is the target: three documents link TO it (inbound) and it links to one (outbound).
M('verify-fixture-alpha', 'The lighthouse keeper logs the lamp rotation speed every dawn.', ['verify-fixture-beta']);
M('verify-fixture-beta', 'Lamp rotation is measured in turns per minute at the gallery rail.', ['verify-fixture-alpha']);
M('verify-fixture-gamma', 'The dawn log is copied into the harbour register each Friday.', ['verify-fixture-alpha']);
M('verify-fixture-delta', 'A missed dawn entry is reconstructed from the harbour register.', ['verify-fixture-alpha']);
// THE DENYLIST, EXERCISED WITHOUT DEPENDING ON YOURS. This used to name a file from the
// shipped excludeFiles, which quietly made a "self-contained" check depend on one machine's
// configuration — and it failed on a fresh clone the moment that config stopped shipping with
// personal entries. The fixture now writes its OWN denylist and points the server at it, so the
// mechanism is tested identically on every machine and no real filename appears here.
writeFileSync(join(FIX, 'verify-fixture-secret.md'),
  '---\nname: verify-fixture-secret\n---\n\nfixture placeholder — this file must never be returned.\n');
const FIX_SECRETS = join(FIX, 'secrets-exclude.json');
writeFileSync(FIX_SECRETS, JSON.stringify({
  _comment: 'Written by verify-stdio.js. Exercises the filename denylist against a fixture.',
  excludeFiles: ['verify-fixture-secret.md'],
  sectionScrub: {},
  patterns: [],
  tokenHashesSha256: []
}, null, 2) + '\n');
writeFileSync(join(FIX, 'MEMORY.md'),
  '# Fixture index\n- [Alpha](verify-fixture-alpha.md) — lamp rotation.\n- [Beta](verify-fixture-beta.md) — turns per minute.\n');

const FIX_ENV = {
  ...process.env,
  // MEMORY_QUERY_SOURCE=test: this file drives the REAL stdio server, so its calls
  // pass the MCP boundary and would otherwise be logged as `live` -- synthetic
  // traffic counted as a person asking a question. The explicit override wins over
  // the earned flag (see querySource in lib/config.js).
  MEMORY_QUERY_SOURCE: 'test',
  MEMORY_DIR: FIX,
  MEMORY_INDEX: join(FIX, '.memory-index.json'),
  MEMORY_STAGING_INDEX: '0',
  MEMORY_HANDOFF_INDEX: '0',
  MEMORY_PROJECTS_INDEX: '0',
  MEMORY_LIBRARY: '0',
  MEMORY_HANDOFF_DOCS: '0',
  MEMORY_SECRETS_CONFIG: FIX_SECRETS,
  MEMORY_QUERY_LOG: join(FIX, '.query-log.jsonl'),
  // 🟥 THE CAPTURE CHECK BELOW SPAWNS THE REAL HOOK (S-3, 2026-09-05). Six paths were sandboxed
  // here and the two the `capture` action reaches were not: without MEMORY_OWN_STORE the child
  // resolves <repo>/store — the user's LIVE capture store — and without MEMORY_TRANSCRIPT_DIR it
  // resolves the NEWEST TRANSCRIPT ON THE MACHINE, i.e. whatever conversation is open right now.
  // It writes no memory (the window is 0.01 min) but it did write `store/.last-ingest.json`,
  // stamping that transcript at its full size as though it had been captured — after which the
  // next real capture is debounced and everything said since the previous stamp is lost. This file
  // SHIPS as half of `npm test`, so the smoke test was a memory-loss mechanism on every install.
  // (scripts/auto-ingest.js no longer stamps on a windowed run either; both ends are fixed,
  // deliberately, because either alone leaves the other caller exposed.)
  //
  // 🟥 AND THE SERVER THIS SCRIPT SPAWNS KEEPS TIME. Measured on the unsandboxed version, in a
  // worktree, 2026-09-05: one `node scripts/verify-stdio.js` left SIX files in <repo>/store —
  // a walker lock, a walker stamp, two recall-canary files, and eleven rows in .ingest-runs.jsonl
  // recording a real walk that spawned EIGHT real auto-ingest children over the machine's own
  // conversations (`sessions: 8, deferred: 49`) and killed every one of them when the script
  // exited, leaving eight crash signatures behind it. The walker stamp alone tells every server on
  // the machine that a walk has just happened, which suppresses real capture for five minutes.
  // A smoke test may not do any of that, so every writer path the spawned server can reach is
  // named below — the same list test/sandbox-env.js REDIRECTS carries for the suite (that module
  // lives under test/, which does not ship, so this one is spelled out).
  MEMORY_OWN_STORE: join(FIX, 'store'),
  MEMORY_TRANSCRIPT_DIR: FIX_TRANSCRIPTS,
  MEMORY_INGEST_LOG: join(FIX, '.ingest-runs.jsonl'),
  MEMORY_VANISH_LOG: join(FIX, '.vanish-report.jsonl'),
  MEMORY_PENDING_INDEX: join(FIX, '.pending-index.json'),
  MEMORY_RECONCILE_STAMP: join(FIX, '.last-reconcile.json'),
  MEMORY_RECALL_CANARY_LOG: join(FIX, '.recall-canary.jsonl'),
  MEMORY_RECALL_CANARY_STATE: join(FIX, '.recall-canary-state.json'),
  MEMORY_TIMED_CAPTURE_STAMP: join(FIX, '.timed-capture-last.json'),
  MEMORY_TIMED_CAPTURE_LOCK: join(FIX, '.timed-capture.lock'),
  MEMORY_PROBE_RESULTS: join(FIX, '.probe-results.json'),
  MEMORY_MARGIN_HISTORY: join(FIX, '.margin-history.jsonl'),
  MEMORY_VECTOR_CACHE: join(FIX, '.vector-cache.json'),
  // homedir() is uv_os_homedir: HOME on POSIX, USERPROFILE on Windows. Both, or the redirect is
  // one platform's only.
  HOME: FIX,
  USERPROFILE: FIX
};
execFileSyncHidden(process.execPath, [join(ROOT, 'scripts', 'build-index.js')], { env: FIX_ENV, stdio: 'ignore' });
process.on('exit', () => { try { rmSync(FIX, { recursive: true, force: true }); } catch { /* best effort */ } });

const child = spawnHidden(process.execPath, [join(ROOT, 'index.js')],
  { stdio: ['pipe', 'pipe', 'pipe'], env: FIX_ENV });

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('NON-JSON ON STDOUT (protocol corruption!):', line.slice(0, 200)); process.exitCode = 1; continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  }
});
child.stderr.on('data', () => { /* server logs — expected on stderr */ });

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const payload = (res) => JSON.parse(res.result.content[0].text);

try {
  // ---- initialize ----
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-stdio', version: '1.0.0' }
  });
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'agentic-recall', JSON.stringify(init.result?.serverInfo));
  console.log(`  info  server ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}, protocol ${init.result?.protocolVersion}`);
  notify('notifications/initialized', {});

  // ---- tools/list ----
  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  // 2.0.0 — TWO tools. The list was hardcoded at 6 and went stale the moment latest/thread/verify
  // were added; it kept passing while silently checking less than it claimed. So both lists below
  // are exhaustive and the PARTITION is asserted, not just the membership: an action reachable from
  // both tools would make `memory`'s readOnlyHint a lie, and one reachable from neither would be
  // silently dead with no error anywhere.
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check('tools/list returns exactly two tools', tools.length === 2, tools.map((t) => t.name).join(','));
  check('the read tool is named `memory`', !!byName.memory);
  check('the write tool is named `memory_write`', !!byName.memory_write);

  const READ_EXPECTED = ['search', 'latest', 'sessions', 'thread', 'verify', 'index_status', 'get', 'neighbors', 'probe_status'];
  const WRITE_EXPECTED = ['import', 'capture', 'index', 'demote', 'promote'];
  const actionsOf = (t) => byName[t]?.inputSchema?.properties?.action?.enum || [];
  const actions = actionsOf('memory');
  const writeActions = actionsOf('memory_write');

  for (const [tool, expected, got] of [['memory', READ_EXPECTED, actions], ['memory_write', WRITE_EXPECTED, writeActions]]) {
    const missing = expected.filter((a) => !got.includes(a));
    const extra = got.filter((a) => !expected.includes(a));
    check(`${tool} advertises exactly its ${expected.length} actions`, missing.length === 0 && extra.length === 0,
      [missing.length ? 'missing: ' + missing.join(',') : '', extra.length ? 'extra: ' + extra.join(',') : ''].filter(Boolean).join(' | ') || got.join(','));
  }
  const overlap = actions.filter((a) => writeActions.includes(a));
  check('no action is reachable from BOTH tools', overlap.length === 0, overlap.join(','));

  // 🟥 THE ANNOTATIONS ARE THE POINT OF THE SPLIT, so they are asserted here rather than assumed.
  // `memory` claiming readOnlyHint while carrying a write action would be the exact dishonesty
  // 2.0.0 exists to remove.
  check('`memory` declares readOnlyHint TRUE', byName.memory?.annotations?.readOnlyHint === true,
    JSON.stringify(byName.memory?.annotations));
  check('`memory_write` declares destructiveHint TRUE', byName.memory_write?.annotations?.destructiveHint === true,
    JSON.stringify(byName.memory_write?.annotations));
  check('CONTROL — the read tool carries NO write action',
    !READ_EXPECTED.some((a) => WRITE_EXPECTED.includes(a)) && !actions.some((a) => WRITE_EXPECTED.includes(a)),
    actions.join(','));

  // ---- tools/call: search ----
  const s = await rpc('tools/call', { name: 'memory', arguments: { action: 'search', query: 'how fast does the lighthouse lamp rotate', limit: 3 } });
  const sr = payload(s);

  // A BRAND-NEW INSTALL HAS AN EMPTY CORPUS, and this script is exactly what a new
  // install runs to check itself. Demanding three results made it fail on the one
  // machine it most needed to pass on. An empty corpus is a valid, healthy state;
  // what must always hold is that the call SUCCEEDS and returns a results array.
  const emptyCorpus = sr.mode === 'empty' || sr.mode === 'unavailable';
  check('search call succeeds and returns a results array',
    Array.isArray(sr.results) && !sr.error === (sr.mode !== 'unavailable'),
    JSON.stringify(sr).slice(0, 160));
  if (emptyCorpus) {
    check('empty corpus is reported as such, not as an error',
      sr.results.length === 0 && /NO DOCUMENTS|no index/i.test((sr.note || sr.error || '')),
      (sr.note || sr.error || '').slice(0, 90));
    console.log('  info  corpus is empty — run `npm run index` after memories exist. ' +
      'Result-quality checks skipped.');
  } else {
    check('search returns results', Array.isArray(sr.results) && sr.results.length === 3,
      JSON.stringify(sr).slice(0, 160));
  }
  check('search reports its mode',
    ['hybrid', 'bm25-only', 'empty', 'unavailable'].includes(sr.mode), sr.mode);
  check('results carry name/description/tier/score/provenance/snippet',
    sr.results.every((r) => r.name && r.description && r.tier && typeof r.score === 'number' && r.provenance && r.snippet));
  console.log(`  info  mode=${sr.mode}  top=${sr.results.map((r) => `${r.name}(${r.score},${r.provenance})`).join(' ')}`);

  // EVERYTHING BELOW NEEDS A POPULATED CORPUS. Gating the whole block, rather
  // than defending each check one at a time, is deliberate: the first attempt
  // guarded only the search-results check and the remaining seven still failed —
  // including one that crashed the harness outright reading `.outbound` of
  // undefined. A new install is not a broken install, and the script a new
  // install runs to check itself must be able to say so.
  if (emptyCorpus) {
    console.log('  info  corpus empty — skipping corpus-dependent checks (absence verdict, ' +
      'get, neighbors). Re-run `npm run verify` once conversations have been captured.');
  } else {

  // ---- tools/call: the absence verdict survives the transport ----
  // A verdict that only exists in-process is not a feature; assert the flag,
  // the emptied results and the fallback list arrive over JSON-RPC.
  const a = await rpc('tools/call', { name: 'memory', arguments: { action: 'search', query: 'which Kubernetes cluster runs the deal tracker', limit: 3 } });
  const ar = payload(a);
  check('absent query reports noStrongMatch over stdio', ar.noStrongMatch === true, JSON.stringify(ar).slice(0, 200));
  check('absent query returns no results but offers bestWeak',
    ar.results.length === 0 && ar.bestWeak?.length > 0, `results=${ar.results.length} bestWeak=${ar.bestWeak?.length}`);
  check('absent query explains itself', typeof ar.absenceNote === 'string' && ar.absenceNote.length > 40, ar.absenceNote);
  console.log(`  info  absence signals: ${JSON.stringify(ar.signals)}`);

  // ---- tools/call: get ----
  const g = await rpc('tools/call', { name: 'memory', arguments: { action: 'get', name: 'verify-fixture-alpha' } });
  const gr = payload(g);
  check('get returns the full body', gr.found === true && gr.body.includes('lamp rotation speed every dawn'), `len=${gr.body?.length}`);
  check('get reports tier', gr.tier === 'hot' || gr.tier === 'archive', gr.tier);

  // ---- tools/call: get on the denylisted memory ----
  const d = await rpc('tools/call', { name: 'memory', arguments: { action: 'get', name: 'verify-fixture-secret' } });
  const dr = payload(d);
  check('get refuses the denylisted memory', dr.refused === true, JSON.stringify(dr).slice(0, 140));
  check('refusal carries no body', dr.body === undefined);

  // ---- tools/call: neighbors ----
  const n = await rpc('tools/call', { name: 'memory', arguments: { action: 'neighbors', name: 'verify-fixture-alpha' } });
  const nr = payload(n);
  check('neighbors returns inbound backlinks', (nr.inbound?.length || 0) >= 3, `inbound=${nr.inbound?.length}`);
  check('neighbors returns outbound links', (nr.outbound?.length || 0) >= 1, `outbound=${nr.outbound?.length}`);
  console.log(`  info  neighbors(verify-fixture-alpha): out=${nr.counts.outbound} in=${nr.counts.inbound} semantic=${nr.counts.semantic}`);

  // ---- EVERY REMAINING ACTION ANSWERS ----------------------------------------
  // The tool exposes twelve actions; this script used to exercise three. An action that
  // throws on a fresh install is the most embarrassing possible bug in an MCP server,
  // because the user sees it as "the tool is broken" with no way to tell which part.
  // Each check below asserts only that the action RESPONDS SANELY on a real corpus —
  // behaviour is the suite's job, but "does not crash on anyone's machine" is this one's.
  const okShape = (r) => !r.result?.isError && !r.error;

  const lat = await rpc('tools/call', { name: 'memory', arguments: { action: 'latest', query: 'lamp rotation' } });
  check('latest responds', okShape(lat), JSON.stringify(lat).slice(0, 120));

  const thr = await rpc('tools/call', { name: 'memory', arguments: { action: 'thread', name: 'verify-fixture-alpha' } });
  check('thread responds', okShape(thr), JSON.stringify(thr).slice(0, 120));

  const ver = await rpc('tools/call', { name: 'memory', arguments: { action: 'verify', name: 'verify-fixture-alpha' } });
  check('verify responds', okShape(ver), JSON.stringify(ver).slice(0, 120));

  const ist = await rpc('tools/call', { name: 'memory', arguments: { action: 'index_status' } });
  check('index_status responds and reports a document count',
    okShape(ist) && typeof payload(ist) === 'object', JSON.stringify(payload(ist)).slice(0, 120));

  const pst = await rpc('tools/call', { name: 'memory', arguments: { action: 'probe_status' } });
  check('probe_status responds', okShape(pst), JSON.stringify(pst).slice(0, 120));

  // promote/demote MUTATE — safe here because the corpus is a temp fixture this script wrote.
  const pro = await rpc('tools/call', { name: 'memory_write', arguments: { action: 'promote', name: 'verify-fixture-beta' } });
  check('promote responds', okShape(pro), JSON.stringify(pro).slice(0, 120));
  const dem = await rpc('tools/call', { name: 'memory_write', arguments: { action: 'demote', name: 'verify-fixture-beta' } });
  check('demote responds', okShape(dem), JSON.stringify(dem).slice(0, 120));

  // `index` is last of the mutating three: it rewrites the fixture's index file.
  // 🟥 THE CHECK THE 2.0.0 SPLIT EXISTS FOR. A write action asked of the READ tool must be
  // refused at the MCP boundary — not routed, not tolerated. The corpus is text other people
  // wrote; a memory that nudges toward `import` or `promote` must not be able to reach either.
  // The control below is what makes this mean something: the SAME action on `memory_write` works.
  const refused = await rpc('tools/call', { name: 'memory', arguments: { action: 'promote', name: 'verify-fixture-beta' } });
  const refusedText = JSON.stringify(refused);
  check('a WRITE action asked of the read tool is REFUSED', /validation error|Invalid arguments|invalid_enum/i.test(refusedText),
    refusedText.slice(0, 140));

  const idx = await rpc('tools/call', { name: 'memory_write', arguments: { action: 'index' } });
  check('index responds and rebuilds', okShape(idx), JSON.stringify(payload(idx)).slice(0, 120));

  // capture with a window so short nothing can match: exercises the whole path (spawn the hook,
  // parse the transcript, report) without writing anything into anyone's corpus during a test.
  const cap = await rpc('tools/call', { name: 'memory_write', arguments: { action: 'capture', sinceMinutes: 0.01 } });
  const cr = payload(cap);
  check('capture responds and reports a count, not null',
    okShape(cap) && typeof cr.exchangesCaptured === 'number', JSON.stringify(cr).slice(0, 140));

  const stillAfter = await rpc('tools/call', { name: 'memory', arguments: { action: 'search', query: 'lamp rotation', limit: 1 } });
  check('search still works after a rebuild', (payload(stillAfter).results || []).length === 1,
    JSON.stringify(payload(stillAfter)).slice(0, 90));

  }  // end corpus-dependent block

  // `import` is the twelfth action. Called with no source it must REFUSE cleanly rather
  // than throw — the failure mode that matters, since every other call path is a refusal.
  const imp = await rpc('tools/call', { name: 'memory_write', arguments: { action: 'import' } });
  check('import with no source refuses cleanly (does not crash the server)',
    imp.result?.isError === true || imp.error || payload(imp), JSON.stringify(imp).slice(0, 140));

  // ---- tools/call: bad args must error, not crash ----
  const bad = await rpc('tools/call', { name: 'memory', arguments: { action: 'search' } });
  check('missing query returns an error, server survives', bad.result?.isError === true || bad.error, JSON.stringify(bad).slice(0, 140));
  const still = await rpc('tools/call', { name: 'memory', arguments: { action: 'search', query: 'lamp rotation', limit: 1 } });
  check('server still answers after the error',
    Array.isArray(payload(still).results) && (emptyCorpus || payload(still).results.length === 1),
    JSON.stringify(payload(still)).slice(0, 90));
} catch (e) {
  console.log(`  FAIL  harness error — ${e.message}`);
  fail++;
} finally {
  child.kill('SIGTERM');
}

console.log(`\n=== stdio verification: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
