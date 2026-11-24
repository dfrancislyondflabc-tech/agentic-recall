// MEM-110 — A STALE CURATED INDEX MORE THAN 8 FILES BEHIND MUST GET REBUILT, NOT REFUSED FOREVER.
//
// THE BUG (found 2026-11-24 on the author's own machine): the curated index was last built 2026-09-28 and 166 memory
// files had changed since. Three paths could rebuild it and none did: scripts/auto-ingest.js rebuilds STAGING only;
// memory_write reindexes, but memories saved with ordinary file tools never pass through it; and the inline repair
// refuses above FRESHNESS.maxInlineFiles (8) — "a full rebuild in disguise". After one busy day the count passed 8 and
// every search after that refused again, honestly stamped STALE and never repaired.
//
// THE FIX: over the limit, the same background rebuild the corrupt-index repair (MEM-59) uses starts off the request.
// This proves, on the real server over stdio, that (1) the first search over a >8-stale index says a rebuild started,
// (2) the index becomes current without any manual step and a search finds the CHANGED content, and (3) with the kill
// switch MEMORY_STALE_BACKGROUND_REBUILD=0 the old refusal stands (the switch is real, and the control can fail).
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const NL = String.fromCharCode(10);
const TOPICS = ['wheel truing', 'brake bleeding', 'sourdough starter', 'quarterly taxes', 'guitar action', 'chain wear',
  'tyre pressure', 'espresso grind', 'lawn mowing', 'paint drying', 'bread proofing', 'fence staining'];

function writeCorpus(mem, marker) {
  TOPICS.forEach((t, i) => {
    const name = t.replace(/\s+/g, '-');
    writeFileSync(join(mem, name + '.md'), '---' + NL + 'name: ' + name + NL + 'description: "notes on ' + t + '"' + NL +
      'metadata:' + NL + '  type: project' + NL + '---' + NL + 'Plain notes about ' + t + '. ' + (marker && i < 10 ? marker(i) : '') + NL);
  });
}

function startServer(env) {
  const srv = spawn(process.execPath, [join(ROOT, 'index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = ''; const pending = new Map(); let id = 0;
  srv.stdout.on('data', (d) => { buf += d; let i;
    while ((i = buf.indexOf(NL)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not a frame */ } } });
  const call = (method, params) => new Promise((res, rej) => { const n = ++id; pending.set(n, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + NL);
    setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout')); } }, 180000); });
  const search = async (tool, query) => { const r = await call('tools/call', { name: tool, arguments: { action: 'search', query, scope: 'curated', limit: 3 } });
    try { return JSON.parse(r.result?.content?.[0]?.text || '{}'); } catch { return {}; } };
  return { srv, call, search };
}

async function scenario(dir, { switchOff }) {
  const mem = join(dir, 'memory'); mkdirSync(mem, { recursive: true });
  const env = { ...process.env, MEMORY_DIR: mem, MEMORY_INDEX: join(dir, 'idx.json'), MEMORY_OWN_STORE: join(dir, 'store'),
    MEMORY_STAGING_INDEX: '0', MEMORY_HANDOFF_INDEX: '0', MEMORY_PROJECTS_INDEX: '0', MEMORY_AUTHOR_CORPUS: '0',
    MEMORY_VECTOR_CACHE: join(dir, 'vec-cache.json'), MEMORY_QUERY_LOG: '0', MEMORY_SCHEDULER: '0',
    ...(switchOff ? { MEMORY_STALE_BACKGROUND_REBUILD: '0' } : {}) };
  writeCorpus(mem, null);
  const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-index.js')], { env, encoding: 'utf8', windowsHide: true });
  if (b.status !== 0) return { error: 'build failed: ' + String(b.stderr || '').slice(-200) };
  // 10 of 12 files change (over the inline limit of 8), with mtimes clearly after the build
  writeCorpus(mem, (i) => 'Update: the zebra-crossing rule ' + i + ' now applies.');
  const later = new Date(Date.now() + 5000);
  for (const t of TOPICS.slice(0, 10)) utimesSync(join(mem, t.replace(/\s+/g, '-') + '.md'), later, later);
  const { srv, call, search } = startServer(env);
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mem110', version: '1' } });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + NL);
    const tool = ((await call('tools/list', {})).result?.tools || [])[0]?.name;
    const first = await search(tool, 'zebra-crossing rule');
    let last = first; const t0 = Date.now();
    while (Date.now() - t0 < (switchOff ? 6000 : 120000)) { await new Promise((r) => setTimeout(r, 1000)); last = await search(tool, 'zebra-crossing rule'); if (!switchOff && last.indexStale === false) break; }
    return { first, last, ms: Date.now() - t0 };
  } finally { await stopChild(srv); }
}

export async function staleBackgroundRebuildTests({ check, group }) {
  group('MEM-110 — a curated index more than 8 files behind is rebuilt in the background, not refused forever');
  const dir = mkdtempSync(join(tmpdir(), 'mem110-'));
  try {
    const on = await scenario(join(dir, 'on'), { switchOff: false });
    if (on.error) { check('fixture index builds', false, on.error); return; }
    check('the first search over a >8-stale index says a background rebuild started', on.first.indexStale === true && /REBUILD HAS BEEN STARTED in the background/.test(on.first.staleWarning || ''), String(on.first.staleWarning || '').slice(0, 200));
    check('the index becomes current with no manual step (within 120 s)', on.last.indexStale === false, `after ${on.ms} ms: indexStale=${on.last.indexStale} ${String(on.last.staleWarning || '').slice(0, 160)}`);
    check('...and a search then finds the CHANGED content', (on.last.results || []).length > 0, JSON.stringify((on.last.results || []).map((r) => r.name)));
    const off = await scenario(join(dir, 'off'), { switchOff: true });
    check('control: MEMORY_STALE_BACKGROUND_REBUILD=0 keeps the old refusal (no rebuild, still stale)', off.first.indexStale === true && off.last.indexStale === true && /switched off/.test(off.first.staleWarning || ''), String(off.first.staleWarning || '').slice(0, 200));
  } finally { await cleanupSandbox(dir); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0;
  await staleBackgroundRebuildTests({ check: (n, ok, d = '') => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? ' — ' + d : '')); } }, group: (g) => console.log('\n' + g) });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
