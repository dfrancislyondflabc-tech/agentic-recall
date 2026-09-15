// test/public/published-real-book.mjs — INSTALL FROM NPM, THEN DO REAL WORK.
//
// 🟥 THE GAP THIS FILLS. CI already had two Windows jobs that each did half of this:
//   `install from npm (windows)` installs the PUBLISHED package — then only checks it starts.
//   `real-book-windows`          imports a REAL Gutenberg book — but from the CHECKOUT.
// So the artefact a user actually installs had never been made to do real work on Windows.
// Every bug that lives in packaging-plus-workload (a file missing from files[], a path that only
// breaks under %APPDATA%, a model cache that cannot write where npm put it) fell between them.
//
// This installs agentic-recall from the registry, imports a real book with CRLF line endings and
// Gutenberg front matter, indexes it, searches it, and asserts the book comes back.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';
const NPMOPT = WIN ? { shell: true } : {};
const SPEC = process.argv[2] || 'agentic-recall@2';

let failures = 0;
const ok = (s) => console.log(`  ok    ${s}`);
const bad = (s) => { failures++; console.log(`  🟥    ${s}`); };

const T = mkdtempSync(join(tmpdir(), 'ar-real-'));
const proj = join(T, 'proj');
const mem = join(T, 'memories');
mkdirSync(proj, { recursive: true });
mkdirSync(mem, { recursive: true });

console.log(`published real-book check: ${SPEC} on ${process.platform}`);

// ---- 1. install from the registry, the way a user does --------------------------------------
execFileSync(NPM, ['init', '-y'], { cwd: proj, stdio: 'pipe', ...NPMOPT });
execFileSync(NPM, ['install', SPEC, '--no-audit', '--no-fund'], { cwd: proj, stdio: 'pipe', ...NPMOPT });
const entry = join(proj, 'node_modules', 'agentic-recall', 'index.js');
ok(`installed ${SPEC} from the registry`);

// ---- 2. a REAL book, with the messy bits --------------------------------------------------
const URL = 'https://www.gutenberg.org/files/74/74-0.txt';   // Tom Sawyer: CRLF, front matter, licence trailer
let book;
try {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  book = await res.text();
} catch (e) {
  console.log(`  SKIP  could not download the book (${e.message}) — network-dependent test`);
  process.exit(0);
}
if (book.length < 100000) { bad(`book download too short (${book.length} chars)`); }
const bookPath = join(T, 'tom-sawyer.txt');
writeFileSync(bookPath, book);
ok(`downloaded a real book: ${book.length.toLocaleString()} chars`);

// ---- 3. drive the INSTALLED server over MCP stdio -------------------------------------------
// 🟥 MEMORY_LIBRARY_DIR IS REQUIRED HERE, and leaving it out is not a product bug.
// Setting MEMORY_DIR without it deliberately suppresses the library corpus (lib/config.js:457),
// and the server refuses the import saying exactly that. The first version of this test omitted
// it and reported a clean product refusal as two failures — the precise harness-fault-reported-
// as-product-fault mistake this suite exists to catch.
const lib = join(T, 'library');
mkdirSync(lib, { recursive: true });
const env = { ...process.env, MEMORY_DIR: mem, MEMORY_LIBRARY_DIR: lib, MEMORY_ROOT: join(T, 'state') };
const srv = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
let n = 0;
const call = (method, params) => new Promise((res, rej) => {
  const id = ++n;
  const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 300000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args });
  const c = r.result?.content?.[0]?.text;
  try { return JSON.parse(c); } catch { return c; }
};

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'real-book', version: '0' } });
  const v = init.result?.serverInfo?.version;
  v ? ok(`server handshake: agentic-recall ${v}`) : bad('no serverInfo from initialize');
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const imported = await tool('memory_write', { action: 'import', path: bookPath, category: 'books' });
  const impStr = JSON.stringify(imported);
  if (/error|refus/i.test(impStr) && !/imported/i.test(impStr)) bad(`import refused: ${impStr.slice(0, 200)}`);
  else ok(`imported the book: ${impStr.slice(0, 120)}`);

  // index, then wait for the async job to finish
  await tool('memory_write', { action: 'index' });
  let built = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await tool('memory', { action: 'search', query: 'whitewash the fence', scope: 'books' });
    if (s && (s.results?.length || s.bestWeak?.length)) { built = true;
      const names = (s.results || []).map((x) => x.name).concat((s.bestWeak || []).map((x) => x.name));
      ok(`searched the indexed book — ${s.results?.length || 0} result(s), top: ${names[0] || '(weak)'}`);
      break; }
  }
  if (!built) bad('indexed book never became searchable within 5 minutes');
} catch (e) {
  bad(`MCP exchange failed: ${e.message}`);
} finally {
  srv.kill();
}

if (failures) { console.log(`\nREFUSED: ${failures} problem(s) using the PUBLISHED package on real content.`); process.exit(3); }
console.log('\nclean — the published package installs and does real work on this platform.');
