#!/usr/bin/env node
// win-recall.mjs — prove on REAL Windows that the portable bundle does not merely load,
// but INDEXES AND RECALLS. "It imported without throwing" is a much weaker claim than
// "it answered a question", and the difference is exactly where sharp/onnx/model-cache
// failures hide: a broken embedder degrades to BM25 SILENTLY by design.
//
//   node ci-helpers/win-recall.mjs <extracted-bundle-dir>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) { console.error('usage: win-recall.mjs <bundle-dir>'); process.exit(2); }
const isWin = process.platform === 'win32';
const nodeBin = join(ROOT, 'runtime', isWin ? 'node.exe' : 'node');
const MEM = join(ROOT, 'memories');
mkdirSync(MEM, { recursive: true });

// Invented facts. They cannot be in any training data, any other corpus, or this repo,
// so a correct answer can ONLY have come from reading these files on this machine.
const FACTS = {
  'quokka-protocol': {
    desc: 'The Quokka Protocol — the port it listens on and who owns it',
    body: 'The Quokka Protocol listens on port 8931 and is owned by the Marlowe team.\n' +
          'It links to [[fenwick-ledger]].\n',
  },
  'fenwick-ledger': {
    desc: 'The Fenwick Ledger — how often it reconciles',
    body: 'The Fenwick Ledger reconciles every 47 minutes and refuses to run on a Tuesday.\n',
  },
};
for (const [name, f] of Object.entries(FACTS)) {
  writeFileSync(join(MEM, name + '.md'),
    `---\nname: ${name}\ndescription: ${f.desc}\nmetadata:\n  type: reference\n---\n\n${f.body}`);
}
writeFileSync(join(MEM, 'MEMORY.md'),
  '# Test index\n\n- [Quokka Protocol](quokka-protocol.md) — port + owner\n' +
  '- [Fenwick Ledger](fenwick-ledger.md) — reconcile cadence\n');

if (!existsSync(nodeBin)) { console.error('FAIL: bundled runtime missing at ' + nodeBin); process.exit(1); }

const child = spawn(nodeBin, [join(ROOT, 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MEMORY_DIR: MEM },
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('  [server] ' + d.toString().split('\n')[0] + '\n'));

let idc = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++idc;
  const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 300000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (args) => {
  const r = await rpc('tools/call', { name: 'memory', arguments: args });
  const text = r.result?.content?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'win-recall', version: '1' } });
  check('initialize', !!init.result?.serverInfo, JSON.stringify(init).slice(0, 120));
  console.log(`  info  server ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version} on ${process.platform}`);

  const tools = await rpc('tools/list', {});
  check('tools/list exposes the memory tool',
    (tools.result?.tools || []).some((t) => t.name === 'memory'));

  // ---- THE RECALL TEST -----------------------------------------------------
  const s1 = await call({ action: 'search', query: 'what port does the Quokka Protocol listen on', limit: 3 });
  const top = s1.results?.[0];
  check('recall: invented fact is found', top?.name === 'quokka-protocol',
    'top=' + (top?.name ?? 'none') + ' of ' + (s1.results?.length ?? 0));
  check('recall: the ANSWER (port 8931) is in the returned text',
    JSON.stringify(s1).includes('8931'));

  const s2 = await call({ action: 'search', query: 'how often does the Fenwick Ledger reconcile', limit: 3 });
  check('recall: second invented fact (47 minutes)', JSON.stringify(s2).includes('47'));

  // Dense vs keyword: mode says which ran. A silent BM25 fallback is the failure this
  // whole Windows job exists to catch, so it is asserted, not merely printed.
  console.log(`  info  retrieval mode = ${s1.mode}  (dense means sharp+onnx+model-cache all work)`);
  check('dense retrieval is live on Windows (not a silent BM25 fallback)', s1.mode === 'hybrid', 'mode=' + s1.mode);

  // ---- ABSENCE: the corpus must not invent ---------------------------------
  const s3 = await call({ action: 'search', query: 'Thalmenor calibration override', limit: 3 });
  const hits = s3.results?.length ?? 0;
  check('absence: an invented non-fact returns nothing or low confidence',
    hits === 0 || s3.confidence === 'low' || s3.confidence === 'none', `hits=${hits} confidence=${s3.confidence}`);

  // ---- the graph, which needs the [[link]] parsed on this platform ---------
  const n = await call({ action: 'neighbors', name: 'quokka-protocol' });
  check('neighbors follows the [[wikilink]] to fenwick-ledger',
    JSON.stringify(n).includes('fenwick-ledger'), JSON.stringify(n).slice(0, 140));
} catch (e) {
  check('harness completed', false, e.message);
} finally {
  child.kill();
}
console.log(failed ? `\n=== WINDOWS RECALL: ${failed} FAILED ===` : '\n=== WINDOWS RECALL: all checks passed ===');
process.exit(failed ? 1 : 0);
