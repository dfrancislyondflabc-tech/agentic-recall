// MEM-120 — THE RULES LANE. A memory that declares `appliesTo` is a standing rule for that area; a search whose query or
// `touching` paths fall in the area returns it under `rules`, OUTSIDE the ranking. Proves: folder / glob / file / topic
// patterns match and near-misses do not; a rule is returned once (sections share a file); at most 5; the ranked
// results are byte-identical with the lane on and off (it never displaces a result); off = no `rules` at all.
import { spawnSync } from 'node:child_process';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';   // repo rule: tests that spawn import the cleanup helper (spawnSync ends its own child)
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export async function rulesLaneTests({ check, group }) {
  group('MEM-120 — rules lane: standing rules returned beside the results when the work touches their area');
  const L = await import(pathToFileURL(join(ROOT, 'lib', 'rules-lane.js')).href);
  check('appliesTo is one comma-separated scalar; empty -> null', JSON.stringify(L.parseAppliesTo('public/, *.html , served file')) === '["public/","*.html","served file"]' && L.parseAppliesTo('') === null && L.parseAppliesTo(undefined) === null);
  const docs = [
    { name: 'parse-check', file: 'a.md', description: 'parse-check served files', appliesTo: ['public/', '*.html', 'served file'] },
    { name: 'restart-app', file: 'b.md', description: 'restart to load a fix', appliesTo: ['server.js', 'lib/**/*.js'] },
    { name: 'restart-app#why', parentName: 'restart-app', file: 'b.md', description: 'section', appliesTo: ['server.js', 'lib/**/*.js'] },
    { name: 'quotes-7-days', file: 'c.md', description: 'quotes valid 7 days', appliesTo: ['quote validity', 'quote_build'] },
    { name: 'ordinary', file: 'd.md', description: 'no rule' }
  ];
  const names = (r) => r.map((x) => x.name).join(',');
  check('a folder entry matches a touched file anywhere under it', names(L.matchRules(docs, { touching: ['/x/server/public/js/app.js'] })) === 'parse-check');
  check('a glob matches by extension; a file entry by name; ** crosses folders',
    names(L.matchRules(docs, { touching: ['index.html'] })) === 'parse-check' && names(L.matchRules(docs, { touching: ['/srv/server.js'] })) === 'restart-app'
    && names(L.matchRules(docs, { touching: ['lib/a/b/c.js'] })) === 'restart-app');
  check('a file name IN THE QUERY counts as touching it', names(L.matchRules(docs, { query: 'why does server.js stall at startup' })) === 'restart-app');
  check('a topic matches as words (any case, - or _ between), not inside other words',
    names(L.matchRules(docs, { query: 'What is the Quote-Validity on reseller deals?' })) === 'quotes-7-days' && names(L.matchRules(docs, { query: 'quotevalidity' })) === '');
  check('near-misses do not match: serverjs, public-notes/, x.htmlx', names(L.matchRules(docs, { touching: ['serverjs', 'public-notes/a.md', 'x.htmlx'] })) === '');
  check('a rule whose sections share its file comes back ONCE', L.matchRules(docs, { touching: ['server.js'] }).length === 1);
  const many = Array.from({ length: 9 }, (_, i) => ({ name: 'r' + i, file: i + '.md', appliesTo: ['deploy'] }));
  check('at most 5 rules', L.matchRules(many, { query: 'deploy it' }).length === 5);

  // end to end: a real curated index; ranked results identical with the lane on and off
  const d = mkdtempSync(join(tmpdir(), 'mem120-'));
  try {
    const mem = join(d, 'mem'); mkdirSync(mem, { recursive: true }); mkdirSync(join(d, 'store'), { recursive: true });
    const w = (n, desc, body, applies) => writeFileSync(join(mem, n + '.md'), `---\nname: ${n}\ndescription: ${desc}\nmetadata:\n  type: feedback\n${applies ? `  appliesTo: "${applies}"\n` : ''}---\n\n${body}\n`);
    w('parse-check-served', 'parse-check every served file after an edit', 'After editing anything under public/, run a parse check: the folder is served live.', 'public/, *.html');
    w('kiln-notes', 'kiln firing schedule', 'The kiln fires at 1200 degrees for eight hours.', null);
    w('glaze-notes', 'glaze recipe', 'The celadon glaze uses two percent iron oxide.', null);
    const env = { ...process.env, HOME: d, USERPROFILE: d, MEMORY_DIR: mem, MEMORY_INDEX: join(d, 'curated.json'), MEMORY_OWN_STORE: join(d, 'store'),
      MEMORY_STAGING_INDEX: '0', MEMORY_HANDOFF_INDEX: '0', MEMORY_PROJECTS_INDEX: '0', MEMORY_INLINE_REINDEX: '0', MEMORY_QUERY_SOURCE: 'test',
      MEMORY_AUTHOR_CORPUS: '0', MEMORY_MODEL_CACHE: join(ROOT, '.model-cache'), MEMORY_VECTOR_CACHE: join(d, 'vc.json'), MEMORY_LOG_LEVEL: 'warn' };
    const src = `const { buildIndex } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'index-store.js')).href)});
      await buildIndex({ force: true, dir: [{ dir: process.env.MEMORY_DIR, corpus: 'curated', primary: true }], out: process.env.MEMORY_INDEX });
      const { search } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'search.js')).href)});
      const rows = (x) => JSON.stringify([...(x.results || []), ...(x.bestWeak ? [].concat(x.bestWeak) : [])].map((y) => y.name + '|' + Number(y.score).toFixed(6)));
      const a = await search('kiln firing temperature', { touching: ['/srv/app/public/index.html'] });
      const b = await search('kiln firing temperature', {});
      process.env.MEMORY_RULES_LANE = '0';
      const c = await search('kiln firing temperature', { touching: ['/srv/app/public/index.html'] });
      process.stdout.write('@@' + JSON.stringify({ aRules: (a.rules || []).map((r) => r.name), aWhy: a.rules && a.rules[0] && a.rules[0].why, bRules: b.rules || null, cRules: c.rules || null,
        same: rows(a) === rows(c) && rows(a) === rows(b), rowsA: rows(a) }) + '@@');`;
    const r0 = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', env, timeout: 180000, maxBuffer: 16 << 20 });
    const m = /@@([\s\S]*)@@/.exec(r0.stdout || '');
    const r = m ? JSON.parse(m[1]) : { error: (r0.stderr || '').slice(-400) };
    check('end to end: touching public/index.html returns the parse-check rule under `rules`, with why', JSON.stringify(r.aRules) === '["parse-check-served"]' && /index\.html/.test(r.aWhy || ''), JSON.stringify(r));
    check('...a request that touches nothing in its area gets no `rules` field at all', r.bRules === null, JSON.stringify(r));
    check('...ranked results are identical with the lane on and off (it never displaces a result); off = no rules', r.same === true && r.cRules === null && r.rowsA && r.rowsA.length > 2, JSON.stringify(r));
  } finally { cleanupSandbox(d, { label: 'mem120' }); }
}
