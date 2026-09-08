
// test/public/fuzz-tool-surface.mjs — abuse every MCP action with hostile arguments.
//
//     npm run test:fuzz
//
// NOT part of `npm test`: it spawns ~200 child processes and takes a few minutes. Run it before a
// release, or when the tool surface changes.
//
// Fixtures only — it copies test/fixtures/gold-corpus into a temp dir with its own HOME, index and
// store, so it is safe to run on any machine and tells you nothing about the author's corpus.
//
// 🟥 A FUZZ THAT FINDS NOTHING PROVES NOTHING UNTIL YOU SHOW IT CAN FIND SOMETHING. Verified by
// injecting `if (args.limit === -5) throw` into tools/memory.js: the run reported 13 THREW findings,
// one per action. Do that again if you ever change what this asserts.
//
// Abuse every MCP action with hostile arguments.
//
// The bar, for ALL of them:
//   * never throw an unhandled error out of the tool — a client sees a crash, not an answer
//   * never return a raw stack trace — it leaks absolute paths and is not actionable
//   * always return parseable structured output
//
// 🟥 MEM-74 — THE PAYLOAD GOES THROUGH A FILE, AND A SPAWN FAILURE IS THE HARNESS'S FAULT.
// This used to pass each case's JSON as an argv element. Windows caps a whole command line at
// 32,767 characters (measured on the PC: fine at 32,000, ENAMETOOLONG at 33,000), so the 200 KB
// query never spawned anything at all — and the harness wrote "NO RESPONSE (exit null)" for all
// 13 actions, counted them as product findings, and exited 0. The product was fine the whole
// time: the 200 KB query is refused at the 8,192-character schema bound in about 5 ms. Two things
// changed. (1) The payload is written to a file in the sandbox and the child reads it, so argv
// carries a path and nothing else — the same call is a few hundred bytes on every platform.
// (2) A spawn that never ran is a HARNESS failure, reported under its own heading and exiting
// non-zero, never mixed into the findings: a harness that cannot deliver its input has measured
// nothing, and saying "0 findings" about it is the worst answer available.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

// DERIVED, never hardcoded. An absolute path here carried a real username and directory
// layout into a public test file; the release gate refused the tree over it. Deriving the
// root from this file's own location is also the only version that works in BOTH trees,
// since the public tree roots this file somewhere else entirely.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const D = mkdtempSync(join(tmpdir(), 'fuzz-'));
mkdirSync(join(D, 'mem'), { recursive: true });
mkdirSync(join(D, 'store'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'test/fixtures/gold-corpus')))
  if (f.endsWith('.md')) writeFileSync(join(D, 'mem', f), readFileSync(join(ROOT, 'test/fixtures/gold-corpus', f)));

const env = { ...process.env, HOME: D, MEMORY_DIR: join(D, 'mem'), MEMORY_INDEX: join(D, 'cur.json'),
  MEMORY_OWN_STORE: join(D, 'store'), MEMORY_STAGING_INDEX: join(D, 'st.json'),
  MEMORY_HANDOFF_INDEX: '0', MEMORY_PROJECTS_INDEX: '0', MEMORY_INLINE_REINDEX: '0',
  MEMORY_QUERY_SOURCE: 'test', MEMORY_AUTHOR_CORPUS: '0',
  MEMORY_MODEL_CACHE: join(ROOT, '.model-cache') };

// build the index once so search paths are exercised for real
spawnSync(process.execPath, ['--input-type=module', '-e',
  "const {buildIndex}=await import(" + JSON.stringify(pathToFileURL(join(ROOT,'lib/index-store.js')).href) + ");" +
  "await buildIndex({force:true,dir:[{dir:process.env.MEMORY_DIR,corpus:'curated',primary:true}],out:process.env.MEMORY_INDEX});"],
  { encoding: 'utf8', env, cwd: ROOT, windowsHide: true });

const BIG = 'x'.repeat(200000);
const NUL = 'a' + String.fromCharCode(0) + 'b';
const ACTIONS = ['search','latest','thread','verify','import','capture','index_status','get',
                 'neighbors','index','demote','promote','probe_status'];
const CASES = [];
const add = (label, args) => CASES.push({ label, args });
for (const a of ACTIONS) {
  add(a + ' no args',        { action: a });
  add(a + ' null query',     { action: a, query: null });
  add(a + ' empty query',    { action: a, query: '' });
  add(a + ' numeric query',  { action: a, query: 12345 });
  add(a + ' array query',    { action: a, query: ['a','b'] });
  add(a + ' object name',    { action: a, name: { evil: true } });
  add(a + ' traversal name', { action: a, name: '../../etc/passwd' });
  add(a + ' absolute name',  { action: a, name: '/etc/passwd' });
  add(a + ' NUL in name',    { action: a, name: NUL });
  add(a + ' 200k query',     { action: a, query: BIG });
  add(a + ' negative limit', { action: a, query: 'wheel', limit: -5 });
  add(a + ' huge limit',     { action: a, query: 'wheel', limit: 1e9 });
  add(a + ' bad scope',      { action: a, query: 'wheel', scope: 'no-such-corpus' });
  add(a + ' scope object',   { action: a, query: 'wheel', scope: { a: 1 } });
  add(a + ' traversal path', { action: a, path: '../../../etc' });
}
add('unknown action',   { action: 'definitely-not-an-action' });
add('action null',      { action: null });
add('action numeric',   { action: 7 });
add('empty object',     {});

// argv[1] is a PATH, not the payload (MEM-74). The child reads the JSON itself, so the command
// line stays a few hundred bytes whatever the case holds.
const script = `
  const { readFileSync } = await import('node:fs');
  const { z } = await import('zod');
  const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'tools/memory.js')).href)});
  const c = new Map(), schemas = new Map();
  m.registerMemoryTools({ tool: (n,d,s,h) => { c.set(n,h); schemas.set(n,s); } });
  const args = JSON.parse(readFileSync(process.argv[1], 'utf8'));
  // THE DOOR A REAL CLIENT COMES THROUGH, AND THEN THE ROOM BEHIND IT. The MCP SDK validates
  // against the registered zod shape before the handler ever runs, so a harness that only calls
  // the handler cannot see the bounds that live in the schema — the 8,192-character \'query\'
  // cap among them, which is what actually stops the 200 KB payload. Both are checked here: the
  // schema verdict is RECORDED, and the handler is called regardless, because "the tool must not
  // throw on rubbish" is a property of the handler and must hold even for input zod would refuse.
  let schemaRefused = null, schemaMs = 0;
  try {
    const t = Date.now();
    const parsed = z.object(schemas.get('memory')).safeParse(args);
    schemaMs = Date.now() - t;
    if (!parsed.success) schemaRefused = String((parsed.error.issues || []).map((i) => i.message).join('; ')).slice(0, 300);
  } catch (e) { schemaRefused = 'SCHEMA CHECK THREW: ' + String((e && e.message) || e).slice(0, 160); }
  let out;
  try {
    const r = await c.get('memory')(args);
    out = { ok: true, schemaRefused, schemaMs, text: String(r && r.content && r.content[0] && r.content[0].text || '').slice(0, 600) };
  } catch (e) { out = { ok: false, schemaRefused, schemaMs, threw: String((e && e.message) || e).slice(0, 200) }; }
  process.stdout.write('@@' + JSON.stringify(out) + '@@');`;

// ---- test hooks. Each one exists because the alternative is an untested harness -----------
//   MEMORY_FUZZ_ONLY   substring filter on the case label — run one shape without the other 199
//   MEMORY_FUZZ_LIMIT  cap the number of cases, so a suite check costs seconds not minutes
//   MEMORY_FUZZ_FAULT=spawn   spawn a path that does not exist, to prove the harness-failure
//                             branch is reachable and DOES exit non-zero (a fuzz that cannot
//                             report its own breakage is the defect MEM-74 names)
//   MEMORY_FUZZ_JSON   write every case's full record to this path, for assertions on the
//                      product's own answer rather than on this file's summary line
const ONLY = process.env.MEMORY_FUZZ_ONLY || '';
const LIMIT = Number(process.env.MEMORY_FUZZ_LIMIT) || 0;
const FAULT = process.env.MEMORY_FUZZ_FAULT || '';
const RUN = CASES.filter((c) => !ONLY || c.label.includes(ONLY)).slice(0, LIMIT || CASES.length);
const EXEC = FAULT === 'spawn' ? join(D, 'no-such-node-executable') : process.execPath;

let crashes = 0, stacks = 0, unparseable = 0;
const findings = [];
const harnessFailures = [];       // the harness could not deliver the input — NOT a product result
const records = [];
const payloadFile = join(D, 'payload.json');
for (const c of RUN) {
  // THE PAYLOAD NEVER TOUCHES THE COMMAND LINE. One file, rewritten per case: the child has
  // exited before the next write, and nothing else reads it.
  writeFileSync(payloadFile, JSON.stringify(c.args));
  const t0 = Date.now();
  const r = spawnSync(EXEC, ['--input-type=module', '-e', script, payloadFile],
    { encoding: 'utf8', env, cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 180000, windowsHide: true });
  const ms = Date.now() - t0;
  // A SPAWN THAT NEVER RAN. spawnSync reports it in `error` (ENOENT, ENAMETOOLONG, E2BIG, EAGAIN),
  // and the old code could not see the difference between that and a tool that crashed, because
  // both arrive as "no @@ marker in stdout". They are opposite verdicts: one says the product
  // misbehaved, the other says this file measured nothing.
  if (r.error) {
    harnessFailures.push(`${c.label}: SPAWN FAILED (${r.error.code || 'unknown'}) ${String(r.error.message || '').slice(0, 140)}`);
    records.push({ label: c.label, ms, harnessFailure: r.error.code || 'unknown' });
    continue;
  }
  const m = /@@([\s\S]*)@@/.exec(r.stdout || '');
  if (!m) { crashes++; findings.push(c.label + ': NO RESPONSE (exit ' + r.status + ') ' + String(r.stderr || '').replace(/\s+/g,' ').slice(-110));
    records.push({ label: c.label, ms, noResponse: true, status: r.status, signal: r.signal }); continue; }
  let o; try { o = JSON.parse(m[1]); } catch { unparseable++; findings.push(c.label + ': unparseable'); records.push({ label: c.label, ms, unparseable: true }); continue; }
  records.push({ label: c.label, ms, ...o });
  if (!o.ok) { crashes++; findings.push(c.label + ': THREW ' + o.threw); continue; }
  if (/\bat \S+ \(.*:\d+:\d+\)/.test(o.text) || /node:internal/.test(o.text)) {
    stacks++; findings.push(c.label + ': STACK TRACE in the response');
  }
}
if (process.env.MEMORY_FUZZ_JSON) writeFileSync(process.env.MEMORY_FUZZ_JSON, JSON.stringify(records, null, 1));

console.log('  ' + RUN.length + ' hostile calls' + (RUN.length === CASES.length ? '' : ` (of ${CASES.length}; filtered)`));
console.log('    threw / no response : ' + crashes);
console.log('    stack trace leaked  : ' + stacks);
console.log('    unparseable output  : ' + unparseable);
for (const f of findings.slice(0, 20)) console.log('      - ' + f);
if (findings.length > 20) console.log('      ...and ' + (findings.length - 20) + ' more');

// 🟥 REPORTED SEPARATELY, AND FATAL. A harness failure is not a smaller finding than a product
// finding — it is the absence of a measurement, and the run must not read as green.
if (harnessFailures.length) {
  console.log('');
  console.log('  HARNESS FAILURE — ' + harnessFailures.length + ' of ' + RUN.length +
    ' cases never reached the product. This run measured NOTHING for them:');
  for (const f of harnessFailures.slice(0, 10)) console.log('      - ' + f);
  if (harnessFailures.length > 10) console.log('      ...and ' + (harnessFailures.length - 10) + ' more');
}
cleanupSandbox(D, { label: 'fuzz-tool-surface' });   // MEM-69: never fail the run over cleanup
// EXIT CODE. The old file always exited 0, so `npm run test:fuzz` in a release gate said nothing
// whatever it found. Harness failures and product findings both fail the run; they are named apart
// above so the reader knows which kind they are looking at.
if (harnessFailures.length || findings.length) process.exitCode = 1;
