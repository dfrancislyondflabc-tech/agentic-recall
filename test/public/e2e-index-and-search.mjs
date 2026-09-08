#!/usr/bin/env node
// End to end on the artefact, on EVERY platform: write a folder of memories, build an index over
// them, drive the real server over MCP stdio, and check the right memory comes back.
//
// 🟥 WHY THIS IS NODE AND NOT SHELL. The previous version of this was inline shell in ci.yml and
// therefore ubuntu-only: Windows got the fixture suite but never once indexed a memory folder and
// retrieved from it. The bug that motivated writing this -- .html import silently needing a macOS
// binary -- was exactly a "works on the author's platform" failure, so the platform coverage is
// the point. One script, three operating systems, identical assertions.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};

const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
const mem = join(dir, 'memory'); mkdirSync(mem, { recursive: true });

// A small corpus with DISTINCT subjects, so a hit is evidence of retrieval and not of there being
// only one document. The queries below deliberately avoid the memories' own wording.
const MEMORIES = {
  'wheel-truing': ['how to true a bicycle wheel',
    'Seat the spokes first, then work opposite pairs a quarter turn at a time until the rim runs straight. Overtightening one side pulls the rim off centre.'],
  'brake-bleed': ['how to bleed hydraulic brakes',
    'Bleed from the caliper upward and keep the reservoir topped up, or air re-enters the line and the lever goes soft again.'],
  'sourdough-starter': ['keeping a sourdough starter alive',
    'Feed it equal weights of flour and water once a day at room temperature. If it is refrigerated, feed it weekly and let it warm up before baking.'],
  'tax-deadline': ['when quarterly estimated taxes are due',
    'Estimated payments fall in mid April, mid June, mid September and mid January of the following year.'],
  'guitar-setup': ['adjusting guitar action and intonation',
    'Set the truss rod for a small amount of neck relief first, then the bridge saddle height, and check intonation last with a tuner at the twelfth fret.']
};
for (const [name, [desc, body]] of Object.entries(MEMORIES)) {
  writeFileSync(join(mem, name + '.md'),
    '---' + NL + 'name: ' + name + NL + 'description: ' + JSON.stringify(desc) + NL +
    'metadata:' + NL + '  type: project' + NL + '---' + NL + body + NL);
}

const env = { ...process.env, MEMORY_DIR: mem, MEMORY_INDEX: join(dir, 'idx.json'),
  MEMORY_OWN_STORE: join(dir, 'store'), MEMORY_STAGING_INDEX: '0',
  MEMORY_HANDOFF_INDEX: '0', MEMORY_PROJECTS_INDEX: '0', MEMORY_AUTHOR_CORPUS: '0' };

// ---- 1. build the index ---------------------------------------------------
const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-index.js')], { env, encoding: 'utf8', windowsHide: true });
check('an index builds over a plain folder of memories', b.status === 0,
  'exit ' + b.status + ' ' + String(b.stderr || '').slice(0, 200));

// ---- 1b. the vector cache must actually PERSIST on this platform ----------
// 🟥 THE BUG THIS EXISTS FOR. cachePath() derived its default from `new URL(import.meta.url).pathname`
// instead of fileURLToPath(). On Windows that is `/C:/Tools/...`, join() turns it into
// `\\C:\\Tools\\...`, and Windows resolves that against the CURRENT drive -- so the cache was written
// somewhere nobody reads and EVERY index re-embedded the whole corpus. Silent: search still worked,
// it was just slow, 18.9 s versus 1.1 s on a real Windows install. Reported 2026-09-05 from a
// Windows box, invisible to every test here because nothing asserted the file came back.
//
// So this asserts the OBSERVABLE consequence, not the path string: build twice, and the second
// build must find the vectors the first one wrote.
{
  const { existsSync } = await import('node:fs');
  const cachePath = join(dir, 'vec-cache.json');
  const cEnv = { ...env, MEMORY_VECTOR_CACHE: cachePath, MEMORY_INDEX: join(dir, 'cache-probe.json') };
  const first = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-index.js')], { env: cEnv, encoding: 'utf8', windowsHide: true });
  check('a vector cache file is written where the code says it is', existsSync(cachePath),
    'expected ' + cachePath + ' :: ' + String(first.stderr || '').slice(-160));
  // AND THE DEFAULT PATH ITSELF, which is where the bug actually lived. The two builds above pin
  // MEMORY_VECTOR_CACHE, so they exercise caching but NOT the derivation that was broken -- and a
  // test that cannot fail on the bug it names is worse than no test. Asserting the shape instead
  // of writing to it, because the default resolves inside the installation and a test must never
  // scribble on a real user's cache. `\\C:\\...` is precisely what raw .pathname produced.
  {
    const { cachePath } = await import(pathToFileURL(join(ROOT, 'lib', 'vector-cache.js')).href);
    const { isAbsolute } = await import('node:path');
    const dflt = cachePath();
    check('the DEFAULT vector-cache path is a valid path on this platform',
      typeof dflt === 'string' && isAbsolute(dflt) && !/^[\\/][A-Za-z]:/.test(dflt), String(dflt));
  }

  // Force a full rebuild so vectors are needed again, and confirm they are READ, not recomputed.
  const second = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-index.js'), '--force'],
    { env: { ...cEnv, MEMORY_INDEX: join(dir, 'cache-probe2.json') }, encoding: 'utf8', windowsHide: true });
  const out2 = String(second.stdout || '') + String(second.stderr || '');
  const hits = /vector cache: (\d+) hits/.exec(out2);
  check('...and the next build READS it back instead of re-embedding everything',
    !!hits && Number(hits[1]) > 0, hits ? hits[0] : out2.slice(-200).replace(/\s+/g, ' '));
}

// ---- 2. a missing root must FAIL, not quietly succeed ----------------------
const bad = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-index.js')],
  { env: { ...env, MEMORY_DIR: join(dir, 'definitely-not-here'), MEMORY_INDEX: join(dir, 'bad.json') }, encoding: 'utf8', windowsHide: true });
check('a nonexistent memory folder exits non-zero, never "success"', bad.status !== 0, 'exit ' + bad.status);

// ---- 3. drive the real server and retrieve --------------------------------
const srv = spawn(process.execPath, [join(ROOT, 'index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = ''; const pending = new Map(); let id = 0;
srv.stdout.on('data', (d) => { buf += d; let i;
  while ((i = buf.indexOf(NL)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not a frame */ } } });
const call = (method, params) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + NL);
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout')); } }, 180000);
});

try {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + NL);
  const tools = await call('tools/list', {});
  const tool = (tools.result?.tools || [])[0]?.name;
  check('the server lists its tool over stdio', !!tool, JSON.stringify(tools.error || ''));

  // Symptom-shaped queries, phrased as a user would rather than as the memory is written.
  //
  // THE CONTRACT IS "ranked first, OR offered as the best weak candidate" -- not "ranked first".
  // On a corpus this small a paraphrase can fall under the absence floor, and the server then
  // returns no results and names the document under `bestWeak` at low confidence. That is the
  // anti-hallucination design working, not a miss: asserting results[0] alone would fail a
  // correct answer and would teach a future reader to loosen the floor to make a test pass.
  const QUERIES = [
    ['my rim wobbles side to side when it spins', 'wheel-truing'],
    ['the brake lever feels spongy', 'brake-bleed'],
    ['how often do I feed the flour and water culture', 'sourdough-starter'],
    ['adjusting action and intonation on a guitar', 'guitar-setup']
  ];
  for (const [q, expected] of QUERIES) {
    const r = await call('tools/call', { name: tool, arguments: { action: 'search', query: q, limit: 3 } });
    const text = r.result?.content?.[0]?.text || '';
    let names = [], weak = [];
    try {
      const j = JSON.parse(text);
      names = (j.results || []).map((x) => x.name);
      weak = (Array.isArray(j.bestWeak) ? j.bestWeak : j.bestWeak ? [j.bestWeak] : []).map((x) => x.name);
    } catch { /* reported below */ }
    const how = names[0] === expected ? 'ranked first' : weak[0] === expected ? 'offered as bestWeak' : null;
    check('"' + q + '" finds ' + expected + (how ? ' (' + how + ')' : ''), how !== null,
      'got results=[' + names.join(', ') + '] bestWeak=[' + weak.join(', ') + ']');
  }
} finally {
  // MEM-69: kill the TREE and wait for the exit before touching the directory the child had open.
  // The sandbox is not removed here — the import section below reuses `dir`; it goes at the end.
  await stopChild(srv);
}

// ---- 4. IMPORT, on every platform ----------------------------------------
// 🟥 THE REASON THIS RUNS ON WINDOWS. `.html` used to be read through `textutil`, which ships only
// with macOS, so a documented format imported fine for the author and was silently SKIPPED on
// Linux and Windows -- 2 of 3 readable files, no error. The class of bug is "works on the platform
// the author happens to use", and the only thing that catches it is running the import somewhere
// else. A book-shaped text file goes in too, because chaptering is the other thing that can differ.
{
  const src = join(dir, 'incoming'); mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'kiln-notes.md'),
    '# Kiln notes' + NL + NL + 'The kiln fires at 1200 degrees for eight hours and must cool overnight before opening.' + NL);
  writeFileSync(join(src, 'studio-rules.html'),
    '<html><body><h1>Studio rules</h1><p>Wedge the clay twice before throwing, and never leave a bat on the wheel head overnight.</p></body></html>' + NL);
  writeFileSync(join(src, 'glazes.csv'),
    'item,rule,detail' + NL + 'kiln,fires at 1200 degrees,cool overnight or the glaze crazes' + NL + 'glaze,stir before dipping,settled glaze goes on thin' + NL);
  writeFileSync(join(src, 'skipme.json'), '{"note":"a format the reader cannot use"}');

  const into = join(dir, 'imported'); mkdirSync(into, { recursive: true });
  const impEnv = { ...env, MEMORY_DIR: into, MEMORY_INDEX: join(dir, 'imp.json') };
  const imp = spawnSync(process.execPath, [join(ROOT, 'scripts', 'import-memories.js'), src],
    { env: impEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const { readdirSync } = await import('node:fs');
  const written = readdirSync(into).filter((f) => f.endsWith('.md'));
  check('import reads markdown, html and csv on this platform', written.length === 3,
    'wrote ' + written.length + ': ' + written.join(', ') + ' | ' + String(imp.stdout || '').slice(-200).replace(/\s+/g, ' '));
  check('...and NAMES the format it could not read', /skipme|json/i.test(String(imp.stdout || '') + String(imp.stderr || '')));

  // A book-shaped document: many chapters in one file, which must chapter rather than land as one blob.
  const book = join(dir, 'book'); mkdirSync(book, { recursive: true });
  let text = '';
  for (let c = 1; c <= 12; c++) {
    text += 'CHAPTER ' + c + NL + NL;
    text += 'This chapter concerns topic number ' + c + '. ' +
      'It records how the apparatus behaved during trial ' + c + ', what was adjusted, and what the ' +
      'operator concluded afterwards. The distinguishing detail of this chapter is marker' + c + '.' + NL + NL;
  }
  writeFileSync(join(book, 'field-manual.txt'), text);
  const lib = join(dir, 'library'); mkdirSync(lib, { recursive: true });
  const bookImp = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'import-memories.js'), book],
    { env: { ...impEnv, MEMORY_LIBRARY_DIR: lib }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const out = String(bookImp.stdout || '') + String(bookImp.stderr || '');
  check('a multi-chapter document under the size limit imports', bookImp.status === 0 && /written/i.test(out),
    'exit ' + bookImp.status + ' :: ' + out.slice(-220).replace(/\s+/g, ' '));
  const badFlag = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'import-memories.js'), book, '--category', 'manuals'],
    { env: impEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  check('an unknown option is REFUSED, not silently ignored', badFlag.status !== 0 && /unknown option/i.test(String(badFlag.stderr || '')),
    'exit ' + badFlag.status);
}

// ---- 5. A REAL BOOK, when asked for one (MEMORY_E2E_REAL_BOOK=1) ---------
// Off by default so the ordinary suite needs no network. Turned on in a CI job, because a
// generated "book" shares the author's assumptions about what a book looks like -- real ones have
// front matter, inconsistent chapter headings, hard-wrapped lines and a licence trailer.
if (process.env.MEMORY_E2E_REAL_BOOK === '1') {
  const URL_ = 'https://www.gutenberg.org/cache/epub/74/pg74.txt';   // Tom Sawyer, public domain
  let book = '';
  try {
    const res = await fetch(URL_, { redirect: 'follow' });
    if (res.ok) book = await res.text();
  } catch (e) { console.log('  (book download failed: ' + e.message + ')'); }
  check('the public-domain book downloaded', book.length > 100000, book.length + ' bytes');
  if (book.length > 100000) {
    const bdir = join(dir, 'realbook'); mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, 'tom-sawyer.txt'), book);
    const lib = join(dir, 'reallib'); mkdirSync(lib, { recursive: true });
    const into2 = join(dir, 'realimported'); mkdirSync(into2, { recursive: true });
    // A REAL book must hit the uncategorised guard rather than landing in the working corpus.
    // Measured 2026-09-05: before the guard reached the CLI, this exact file imported as one
    // 434 KB document with a single heading, straight into the memory folder.
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'import-memories.js'), bdir],
      { env: { ...env, MEMORY_DIR: into2, MEMORY_INDEX: join(dir, 'real.json') },
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const out = String(r.stdout || '') + String(r.stderr || '');
    const { readdirSync: rd } = await import('node:fs');
    check('a real book is REFUSED by the CLI, not filed into working memory',
      r.status !== 0 && /refusing/i.test(out), 'exit ' + r.status + ' :: ' + out.slice(-200).replace(/\s+/g, ' '));
    check('...and nothing was written', rd(into2).filter((f) => f.endsWith('.md')).length === 0);
    // And the structure IS recoverable from real prose, which is why the library path exists.
    const { promoteChapterHeadings } = await import(pathToFileURL(join(ROOT, 'lib', 'import-sources.js')).href);
    const chaptered = promoteChapterHeadings(book);
    check('...while real chapter lines still promote to headings',
      (chaptered.match(/^## /gm) || []).length >= 5, (chaptered.match(/^## /gm) || []).length + ' headings');
  }
}

// MEM-69: the sandbox went unremoved entirely before (the mid-file rm was undone by the import
// section recreating `dir`). Removed here, with the Windows retry, and never fatal.
cleanupSandbox(dir, { label: 'e2e-index-and-search' });

console.log(NL + '=== end-to-end on ' + process.platform + ': ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
