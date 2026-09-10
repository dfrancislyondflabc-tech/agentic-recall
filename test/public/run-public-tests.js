#!/usr/bin/env node
// test/public/run-public-tests.js — the suite that ships.
//
//     npm run test:full
//
// WHY THIS EXISTS AS A SEPARATE FILE. The project's main suite asserts against the author's own
// memories by name, and the file itself carries real addresses and private IPs because several of
// its tests assert on genuine redaction targets. The release gate refuses it, correctly. Scrubbing
// it would weaken exactly the tests that check redaction, so this is a purpose-built suite over
// committed fixtures instead: everything here runs on a machine that has never seen a real memory.
//
// It asserts CONTRACTS, not corpus statistics. Nothing here depends on how many documents exist, on
// wall-clock time, or on any file outside test/fixtures/ and a temp directory it creates itself.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync,
         symlinkSync, statSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync as rmSyncReal, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { spawnOptsForKill } from './kill-tree.mjs';
import { cleanupSandbox, stopChild } from './sandbox-cleanup.mjs';
import { writeZipSync } from '../../lib/zip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const FIXTURES = join(ROOT, 'test', 'fixtures', 'gold-corpus');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function group(t) { console.log(`\n=== ${t} ===`); }

// Every child runs with an isolated everything. A test that can see the developer's real memory
// folder is a test that behaves differently on their machine than in CI.
function sandbox(extra = {}) {
  const d = mkdtempSync(join(tmpdir(), 'recall-public-'));
  mkdirSync(join(d, 'store'), { recursive: true });
  return {
    dir: d,
    env: {
      ...process.env,
      // 🟥 BOTH, and the second one was missing (2026-09-05). os.homedir() reads HOME on POSIX and
      // USERPROFILE on Windows (uv_os_homedir), so every sandbox that set only HOME was not a
      // sandbox on windows-latest at all — the child looked at the RUNNER'S real profile for
      // ~/.claude/projects. Nothing failed, which is worse: the Windows leg of the suite was
      // quietly exercising a different code path from the other two.
      HOME: d,
      USERPROFILE: d,
      MEMORY_DIR: join(d, 'mem'),
      MEMORY_INDEX: join(d, 'curated.json'),
      MEMORY_OWN_STORE: join(d, 'store'),
      MEMORY_STAGING_INDEX: join(d, 'staging.json'),
      MEMORY_HANDOFF_INDEX: '0',
      MEMORY_PROJECTS_INDEX: '0',
      MEMORY_INLINE_REINDEX: '0',
      MEMORY_QUERY_SOURCE: 'test',
      MEMORY_AUTHOR_CORPUS: '0',
      MEMORY_MODEL_CACHE: join(ROOT, '.model-cache'),
      MEMORY_VANISH_LOG: join(d, 'vanish.jsonl'),
      ...extra
    }
  };
}

// Run a snippet in a child process against a sandbox. Returns whatever it prints between @@ markers.
function run(env, body, { cwd = ROOT } = {}) {
  const src = `
    const IDX  = ${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'index-store.js')).href)};
    const SRCH = ${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'search.js')).href)};
    const TOOL = ${JSON.stringify(pathToFileURL(join(ROOT, 'tools', 'memory.js')).href)};
    const out = (v) => process.stdout.write('@@' + JSON.stringify(v) + '@@');
    const buildIndexOver = async (dir, out2, corpus = 'curated') => {
      const { buildIndex } = await import(IDX);
      return buildIndex({ force: true, dir: [{ dir, corpus, primary: true }], out: out2 });
    };
    const memoryTool = async () => {
      const m = await import(TOOL); const c = new Map();
      m.registerMemoryTools({ tool: (n, d, s, h) => c.set(n, h) });
      // 2.0.0 — TWO tools. Routing by action here keeps every existing check's call shape, so
      // this shim is the only place in the harness that knows the split.
      const W = new Set(['import', 'capture', 'index', 'demote', 'promote']);
      return async (args) => {
        const r = await c.get(W.has(args.action) ? 'memory_write' : 'memory')(args);
        return JSON.parse(r.content[0].text);
      };
    };
    ${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env, cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const m = /@@([\s\S]*)@@/.exec(r.stdout || '');
  if (!m) return { __nores: true, stderr: String(r.stderr || '').slice(0, 240), status: r.status };
  try { return JSON.parse(m[1]); } catch { return { __unparsable: m[1].slice(0, 300) }; }
}

const copyFixtures = (to) => { mkdirSync(to, { recursive: true });
  for (const f of readdirSync(FIXTURES)) if (f.endsWith('.md')) writeFileSync(join(to, f), readFileSync(join(FIXTURES, f))); };

console.log('agentic-recall — public test suite (fixtures only, no author corpus)');

// =============================================================================================
group('retrieval — the contracts a memory server has to keep');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { search } = await import(SRCH);
    const quote = 'Pawls get the light oil, never the thick bearing grease';
    const q1 = await search(quote, { limit: 5 });
    // A direct question whose WORDS THE DOCUMENT USES. A pure paraphrase gets refused at this corpus
    // size — a 16-document vocabulary is thin, that is measured and documented behaviour, and
    // asserting otherwise would make this suite flaky rather than strict.
    const q2 = await search('who is allowed to sign off a bike before it goes on sale', { limit: 5 });
    const q3 = await search('what is the airport parking policy for staff cars', { limit: 5 });
    const a = await search('how do I bleed the brakes', { limit: 5 });
    const b = await search('how do I bleed the brakes', { limit: 5 });
    out({
      quoteTop: (q1.results||[])[0]?.name || null,
      quoteSnippet: (q1.results||[])[0]?.snippet || '',
      questionTop: (q2.results||[])[0]?.name || null,
      absent: !!q3.noStrongMatch,
      absentOffersWeak: ((q3.bestWeak||[]).length > 0),
      deterministic: JSON.stringify(a.results) === JSON.stringify(b.results),
      hasScores: (q2.results||[]).every((x) => typeof x.score === 'number')
    });`);
  check('a verbatim quote returns its own memory first',
    String(r.quoteTop).startsWith('grease-rule-pawls'), JSON.stringify(r).slice(0, 220));
  check('...and the snippet actually carries the quoted words',
    /pawls/i.test(r.quoteSnippet || '') && /oil/i.test(r.quoteSnippet || ''), String(r.quoteSnippet).slice(0, 120));
  check('a natural-language question finds the right memory',
    String(r.questionTop).startsWith('volunteer-onboarding'), String(r.questionTop));
  check('a topic the corpus knows nothing about is REFUSED, not answered', r.absent === true, JSON.stringify(r).slice(0, 200));
  check('...and the refusal still offers the nearest candidates', r.absentOffersWeak === true);
  check('the same query twice returns byte-identical results', r.deterministic === true);
  check('every result carries a numeric score', r.hasScores === true);
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('word order is evidence, not noise');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { search } = await import(SRCH);
    const a = await search('light oil on the pawls', { limit: 4 });
    const b = await search('thick grease in the bearing', { limit: 4 });
    out({ a: (a.results||[]).map(x=>x.name), b: (b.results||[]).map(x=>x.name),
          aScores: (a.results||[]).slice(0,2).map(x=>x.score) });`);
  // Two fixtures use the SAME WORDS IN OPPOSITE ROLES, so only word order can separate them. The
  // assertion is RELATIVE on purpose: a third memory (the bearing grease chart) is a perfectly good
  // answer to either question and legitimately outranks both. Demanding a specific document at rank
  // 1 failed for that reason — and asserting it anyway would have been a test tuned to a wrong
  // expectation. What must hold is that the PAIR is ordered correctly.
  const rankOf = (list, name) => (list || []).findIndex((n) => String(n).startsWith(name));
  const aPawls = rankOf(r.a, 'grease-rule-pawls'), aBear = rankOf(r.a, 'grease-rule-bearing');
  const bPawls = rankOf(r.b, 'grease-rule-pawls'), bBear = rankOf(r.b, 'grease-rule-bearing');
  check('“light oil on the pawls” ranks the pawls rule ABOVE the bearing rule',
    aPawls !== -1 && aBear !== -1 && aPawls < aBear, JSON.stringify(r.a));
  check('“thick grease in the bearing” ranks the bearing rule ABOVE the pawls rule',
    bPawls !== -1 && bBear !== -1 && bBear < bPawls, JSON.stringify(r.b));
  check('...and the two questions genuinely disagree (the order flips)',
    (aPawls < aBear) !== (bPawls < bBear), `a=${JSON.stringify(r.a)} b=${JSON.stringify(r.b)}`);
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('reading a memory — get, sections, and live metadata');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const memory = await memoryTool();
    const full  = await memory({ action: 'get', name: 'brake-bleed-procedure' });
    const brief = await memory({ action: 'get', name: 'brake-bleed-procedure', brief: true });
    const missing = await memory({ action: 'get', name: 'no-such-memory-anywhere' });
    out({ found: full.found !== false, hasBody: typeof full.body === 'string' && full.body.length > 0,
          livePath: typeof full.path === 'string',
          briefIsSmaller: JSON.stringify(brief).length < JSON.stringify(full).length,
          briefKeepsBody: typeof brief.body === 'string' && brief.body.length > 0,
          missingIsHonest: missing.found === false && typeof missing.hint === 'string' });`);
  check('get returns the memory', r.found === true, JSON.stringify(r).slice(0, 200));
  check('get returns its body', r.hasBody === true);
  check('get reports where it read it from', r.livePath === true);
  check('get brief:true is smaller than the full response', r.briefIsSmaller === true);
  check('...but still carries the text', r.briefKeepsBody === true);
  check('an unknown name says so instead of guessing', r.missingIsHonest === true);
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('credentials in a note do not reach the index or a search result');
{
  const sb = sandbox();
  mkdirSync(sb.env.MEMORY_DIR, { recursive: true });
  // One shape per rule family. The URL forms were MISSED until 2026-09-04: every other common way a
  // credential appears in a runbook was covered, and `scheme://user:pass@host` — the way a database
  // password actually appears in engineering notes — was not.
  const SECRETS = {
    aws:     'AKIAIOSFODNN7EXAMPLE',
    skToken: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    bearer:  'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    pgUrl:   'postgres://admin:s3cr3tp4ss@db.internal:5432/main',
    redis:   'redis://:onlyapassword@cache.internal:6379',
    // MEM-79, 2026-09-05. Every shape above is one a MACHINE writes. The shape a PERSON writes is a
    // sentence, and it had no rule: the live incident stored `Hunter2-Xk9!pass` in a memory's
    // description and in its search snippet while redacting the AWS key in the very same sentence.
    prosePwd: 'Hunter2-Xk9!pass',
    passcode: 'Wc2Xy9Qz'
  };
  // Those two only exist inside a sentence — the runbook template below has no trigger word in it,
  // and a fixture that cannot fire proves nothing.
  const SENTENCE = {
    prosePwd: 'My test password is Hunter2-Xk9!pass and I will rotate it after the demo.',
    passcode: 'Meeting ID: 252 216 839 480 225 Passcode: Wc2Xy9Qz'
  };
  for (const [k, v] of Object.entries(SECRETS))
    writeFileSync(join(sb.env.MEMORY_DIR, 'creds-' + k + '.md'),
      '---\nname: creds-' + k + '\ndescription: server access notes for ' + k + '\n---\n\n' +
      (SENTENCE[k] || ('The runbook says to connect using ' + v + ' and then restart the service.')) + '\n');
  writeFileSync(join(sb.env.MEMORY_DIR, 'innocent.md'),
    '---\nname: innocent\ndescription: an ordinary note\n---\n\nThe kiln fires at 1200 degrees for eight hours.\n');

  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { readFileSync } = await import('node:fs');
    const idx = readFileSync(process.env.MEMORY_INDEX, 'utf8');
    const { search } = await import(SRCH);
    let body = '';
    for (const q of ['runbook connect restart service', 'server access notes', 'database password'])
      body += JSON.stringify(await search(q, { limit: 10 }));
    out({ idx, body });`);
  const leakedIndex = Object.entries(SECRETS).filter(([, v]) => String(r.idx || '').includes(v)).map(([k]) => k);
  const leakedSearch = Object.entries(SECRETS).filter(([, v]) => String(r.body || '').includes(v)).map(([k]) => k);
  check('no credential shape reaches the index file', leakedIndex.length === 0, 'leaked: ' + leakedIndex.join(', '));
  check('no credential shape reaches a search result', leakedSearch.length === 0, 'leaked: ' + leakedSearch.join(', '));
  // NOT VACUOUS: the notes really were indexed, and the redaction really is what emptied them —
  // an absence check over an index that never saw the file would pass for the wrong reason.
  check('...and those notes ARE in the index, redacted rather than absent',
    String(r.idx || '').includes('creds-prosePwd') && String(r.idx || '').includes('[REDACTED:credential-shaped]'),
    String(r.idx || '').length + ' bytes of index');

  // 🟥 AND THE NEGATIVE CONTROLS. A scrubber that eats ordinary text is not a safer scrubber, it is
  // a broken one — an email address and a plain URL must survive untouched, and so must the
  // sentences that merely TALK about a password. Daniel measured the last three over 2,952 real
  // exchanges: 0 true positives, 3 false, which is why a bare lowercase word never counts as a value.
  const neg = run(sb.env, `
    const { redact } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'secrets.js')).href)});
    const keep = ['write to alice.smith@example.com about it',
                  'see https://example.com/docs for the guide',
                  'the host is https://example.com:8443/health',
                  'scp file user@host:/tmp/x',
                  'the password is required',
                  'password reset link',
                  'the password was provided earlier in this thread',
                  'the default password is supposed to be the serial',
                  'the never-feeds-ranking pin is extended behaviorally',
                  'password-protected zip',
                  'the password field is empty',
                  'unzip -p archive.zip',
                  'PIN is 4 digits'];
    out({ changed: keep.filter((t) => (redact(t).hits || []).length > 0) });`);
  check('...while an email address, a plain URL and prose ABOUT a password are left alone',
    Array.isArray(neg.changed) && neg.changed.length === 0, JSON.stringify(neg.changed));

  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('the corpus boundary — a symlink may not leave it');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const outside = join(sb.dir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.md'),
    '---\nname: secret\ndescription: outside the configured root\n---\n\nCANARY-OUTSIDE-THE-ROOT.\n');
  try { symlinkSync(join(outside, 'secret.md'), join(sb.env.MEMORY_DIR, 'leak.md')); } catch { /* platform */ }
  try { symlinkSync(outside, join(sb.env.MEMORY_DIR, 'outdir')); } catch { /* platform */ }
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(process.env.MEMORY_INDEX, 'utf8');
    const memory = await memoryTool();
    const t1 = await memory({ action: 'get', name: '../../etc/passwd' });
    const t2 = await memory({ action: 'get', name: '/etc/passwd' });
    out({ leaked: raw.includes('CANARY-OUTSIDE-THE-ROOT'),
          traversed: (JSON.stringify(t1) + JSON.stringify(t2)).includes('root:x:'),
          t1Found: t1.found, t2Found: t2.found });`);
  check('a symlink pointing outside the memory root is not read', r.leaked === false, JSON.stringify(r).slice(0, 200));
  check('a traversal path in get() does not escape', r.traversed === false);
  check('...and it refuses rather than throwing', r.t1Found === false && r.t2Found === false, JSON.stringify(r));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('line endings and encodings — the historically worst area');
{
  const sb = sandbox();
  const dir = sb.env.MEMORY_DIR; mkdirSync(dir, { recursive: true });
  const LF = '---\nname: NAME\ndescription: a note about wheel truing and spoke tension\nmetadata:\n  type: project\n---\n\n## First heading\n\nThe rim runs true at last.\n\n## Second heading\n\nSpoke tension matters.\n';
  const mk = (n, t) => writeFileSync(join(dir, n + '.md'), t.replace(/NAME/g, n));
  mk('plain_lf', LF);
  mk('crlf', LF.replace(/\n/g, '\r\n'));
  mk('bom', '﻿' + LF);
  mk('mixed', LF.split('\n').map((l, i) => (i % 2 ? l + '\r\n' : l + '\n')).join(''));
  mk('unicode', LF.replace('a note about', 'a 📊 note with accents café and CJK 記録 about'));
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { readFileSync } = await import('node:fs');
    const idx = JSON.parse(readFileSync(process.env.MEMORY_INDEX, 'utf8'));
    const docs = idx.docs || idx.documents || [];
    const pick = (n) => docs.find((d) => (d.file || '').includes(n + '.md')) || {};
    const rep = {};
    for (const n of ['plain_lf','crlf','bom','mixed','unicode']) {
      const d = pick(n);
      rep[n] = { name: d.name, hasDesc: !!d.description, type: d.type,
                 headings: (d.headings || []).length, fm: d.hasFrontmatter };
    }
    rep.replacementChar = JSON.stringify(docs).includes('\\uFFFD');
    out(rep);`);
  for (const kind of ['crlf', 'bom', 'mixed', 'unicode']) {
    const d = r[kind] || {};
    check(`${kind}: frontmatter parses (name, description, type)`,
      d.name === kind && d.hasDesc === true && d.type === 'project', JSON.stringify(d));
    check(`${kind}: headings survive`, d.headings === 2, JSON.stringify(d));
  }
  check('no U+FFFD replacement characters are introduced', r.replacementChar === false);
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('the index is a cache of a directory, and knows it');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    const { buildIndex } = await import(IDX);
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { readFileSync, writeFileSync } = await import('node:fs');
    const before = JSON.parse(readFileSync(process.env.MEMORY_INDEX, 'utf8'));
    const beforeCount = (before.docs || before.documents || []).length;

    // GUARD 1: an empty root list must never be read as "erase the index".
    let emptyRefused = false;
    try { await buildIndex({ force: true, dir: [], out: process.env.MEMORY_INDEX }); }
    catch { emptyRefused = true; }
    const afterEmpty = JSON.parse(readFileSync(process.env.MEMORY_INDEX, 'utf8'));

    // GUARD 2: a root that does not exist is a misconfiguration, and is REPORTED.
    const rep = await buildIndex({ force: true, out: process.env.MEMORY_INDEX + '.probe',
      dir: [{ dir: process.env.MEMORY_DIR + '-does-not-exist', corpus: 'curated', primary: true }] });

    out({ beforeCount, emptyRefused,
          survivedEmpty: (afterEmpty.docs || afterEmpty.documents || []).length,
          missingRoots: (rep.missingRoots || []).length,
          missingIndexed: rep.filesIndexed });`);
  check('the fixture corpus indexes', r.beforeCount === 16, `got ${r.beforeCount}`);
  check('an EMPTY root list is refused, not treated as "index nothing"', r.emptyRefused === true);
  check('...and the existing index is left intact', r.survivedEmpty === r.beforeCount,
    `${r.survivedEmpty} vs ${r.beforeCount}`);
  check('a root that does not exist is REPORTED, not silently empty', r.missingRoots === 1,
    JSON.stringify(r));
  check('...and it indexed nothing from it', r.missingIndexed === 0);
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('the index header records what it was built from, cheaply comparable');
{
  // WHY THIS MATTERS TO SOMEBODY ELSE'S INSTALL. Whether to rebuild is decided by comparing the
  // folder against the index, and parsing a large index to answer it would cost more than the
  // rebuild. So the header carries {count, digest} over the file listing (id + mtime + size), the
  // check is one stat pass plus a 4 KB read, and the two are computed by the SAME function — if
  // they ever drifted apart the disagreement would be permanent, which is worse than no check.
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    const { indexHeaderOnDisk, indexBuiltAtOnDisk } = await import(IDX);
    const { sourceListingOf } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'corpus.js')).href)});
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);

    const header = indexHeaderOnDisk(process.env.MEMORY_INDEX);
    const live = sourceListingOf(process.env.MEMORY_DIR);
    const builtAt = indexBuiltAtOnDisk(process.env.MEMORY_INDEX);

    // A file appears behind the index: the digest must move, and the count with it.
    await new Promise((r2) => setTimeout(r2, 12));
    writeFileSync(join(process.env.MEMORY_DIR, 'planted.md'),
      '---\\nname: planted\\n---\\n\\nA note written after the index was built.\\n');
    const after = sourceListingOf(process.env.MEMORY_DIR);

    // An index written before this field existed must read as "cannot tell", never "unchanged".
    const oldShape = process.env.MEMORY_INDEX + '.old';
    writeFileSync(oldShape, JSON.stringify({ header: { formatVersion: 2, docCount: 7,
      corpusHash: 'x', builtAt: '2026-01-01T00:00:00.000Z' }, denseEnabled: true, excluded: [], docs: [] }));

    out({ headerCount: header?.sourceListing?.count ?? null,
          matches: header?.sourceListing?.digest === live.digest,
          builtAtAgrees: builtAt === header?.builtAt,
          movedDigest: after.digest !== live.digest,
          movedCount: after.count === live.count + 1,
          stableTwice: sourceListingOf(process.env.MEMORY_DIR).digest === after.digest,
          oldDocCount: indexHeaderOnDisk(oldShape)?.docCount ?? null,
          oldListing: indexHeaderOnDisk(oldShape)?.sourceListing ?? null,
          absent: indexHeaderOnDisk(process.env.MEMORY_INDEX + '.nope') });`);
  check('the header names how many source files the index was built from',
    r.headerCount === 16, JSON.stringify(r).slice(0, 200));
  check('...and its digest matches the one recomputed from the folder', r.matches === true, JSON.stringify(r));
  check('...read out of the same 4 KB as builtAt', r.builtAtAgrees === true, JSON.stringify(r));
  check('a file added behind the index moves the digest', r.movedDigest === true && r.movedCount === true, JSON.stringify(r));
  check('CONTROL: an unchanged folder digests the same twice', r.stableTwice === true, JSON.stringify(r));
  check('an index built before the field reads as "cannot tell", not as "unchanged"',
    r.oldDocCount === 7 && r.oldListing === null, JSON.stringify(r));
  check('...and an index that is not there reads as null', r.absent === null, JSON.stringify(r.absent));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('importing a folder reads every format it claims to, and NAMES what it skipped');
{
  const sb = sandbox();
  const src = join(sb.dir, 'src'); mkdirSync(src, { recursive: true });
  mkdirSync(sb.env.MEMORY_DIR, { recursive: true });
  writeFileSync(join(src, 'note.md'),
    '# Kiln notes\n\nThe kiln fires at 1200 degrees for eight hours and must cool overnight before opening.\n');
  writeFileSync(join(src, 'page.html'),
    '<html><body><h1>Studio rules</h1><p>Wedge the clay twice before throwing, and never leave a bat on the wheel head overnight.</p></body></html>\n');
  writeFileSync(join(src, 'rules.csv'),
    'item,rule,detail\nkiln,fires at 1200 degrees,cool overnight or the glaze crazes\nglaze,stir before dipping,settled glaze goes on thin\n');
  // 🟥 NOT .json any more. This fixture stands for "a format the reader cannot use", and
  // .json stopped being one in 1.8.1: supportedExtensions() had always ADVERTISED it while
  // only a ChatGPT export could actually be read, so a plain JSON file was refused as an
  // "unsupported format .json" in the same response that listed .json as supported. The
  // CHECK below is about naming what was skipped, not about JSON — so it needs an extension
  // that is genuinely unreadable, or it passes for the wrong reason.
  writeFileSync(join(src, 'skipme.bin'), 'a format the reader cannot use');

  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'import-memories.js'), src],
    { encoding: 'utf8', env: sb.env, cwd: ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const outText = (r.stdout || '') + (r.stderr || '');
  const written = existsSync(sb.env.MEMORY_DIR)
    ? readdirSync(sb.env.MEMORY_DIR).filter((f) => f.endsWith('.md')) : [];

  // 🟥 THE BUG THIS PINS. The CLI used to walk the directory itself with /\.(md|txt|markdown)$/i,
  // so `memory({action:"import"})` read a folder's .html and .csv and the CLI the README tells you
  // to run did not — same product, same documented format list, two answers. Measured: the shared
  // reader returned 3 items from this exact folder while the CLI reported "found: 1", and said
  // nothing about the two it dropped.
  check('the folder import reads markdown, html and csv alike', written.length === 3,
    `wrote ${written.length}: ${written.join(', ')} | ${outText.slice(-200)}`);
  check('...and a format it cannot read is NAMED, not silently dropped',
    /ignored\s*:/.test(outText) && /skipme\.bin/.test(outText), outText.slice(-240));

  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('an exchange captured mid-reply says so, and stops saying so when it is finished');
{
  const sb = sandbox();
  const sid = 'ffff0000-1111-2222-3333-444444444444';
  const tx = join(sb.dir, sid + '.jsonl');
  const u = (t, ts) => JSON.stringify({ type: 'user', message: { role: 'user', content: t }, timestamp: ts });
  const a = (t, ts) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, timestamp: ts });
  const long = (w) => (w + ' ').repeat(60).trim();
  writeFileSync(tx, [
    u('a finished question', '2026-09-04T14:00:00Z'),
    a(long('A finished answer about kilns'), '2026-09-04T14:00:10Z'),
    u('the question still being answered', '2026-09-04T15:00:00Z'),
    a(long('A PARTIAL answer still being written'), '2026-09-04T15:00:10Z')
  ].join('\n') + '\n');

  const ingest = () => spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'ingest-transcript.js'), tx, '--write'],
    { encoding: 'utf8', env: sb.env, cwd: ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const flagged = () => readdirSync(sb.env.MEMORY_OWN_STORE).filter((f) => f.endsWith('.md'))
    .filter((f) => /^\s*inFlight:\s*true\s*$/m.test(readFileSync(join(sb.env.MEMORY_OWN_STORE, f), 'utf8')));

  // A HOOK run captures the final exchange even mid-reply, deliberately: deferring it there loses
  // the last exchange of every session, because a transcript quiet for 15 minutes leaves the
  // timer's window and is never revisited. So it is captured AND marked.
  ingest();
  const first = flagged();
  check('the still-being-written exchange is captured AND flagged', first.length === 1,
    `flagged: ${JSON.stringify(first)}`);
  check('...and the settled exchange is not flagged',
    readdirSync(sb.env.MEMORY_OWN_STORE).filter((f) => f.endsWith('.md')).length === 2, 'expected 2 files');

  // 🟥 THE FLAG MUST NOT STICK. It failed this first time: rewrites carry forward metadata the
  // extractor does not own, so the flag survived and a finished exchange stayed marked forever.
  // A stale in-flight flag is worse than none — it teaches readers to ignore it.
  appendFileSync(tx, u('a following human turn', '2026-09-04T16:00:00Z') + '\n');
  ingest();
  check('the flag CLEARS once a later human turn exists', flagged().length === 0,
    `still flagged: ${JSON.stringify(flagged())}`);

  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('importing an ARCHIVE: reads what it claims, and cannot write outside itself');
{
  const sb = sandbox();
  const src = join(sb.dir, 'src'); mkdirSync(src, { recursive: true });
  mkdirSync(sb.env.MEMORY_DIR, { recursive: true });
  writeFileSync(join(src, 'kiln.md'),
    '---\nname: kiln\ndescription: kiln firing schedule\n---\n\nThe kiln fires at 1200 degrees for eight hours and cools overnight before opening.\n');
  writeFileSync(join(src, 'glaze.md'),
    '---\nname: glaze\ndescription: glaze mixing\n---\n\nStir the glaze bucket thoroughly before every dip or it goes on thin and patchy.\n');
  const zip = join(sb.dir, 'notes.zip');
  // 🟥 THIS FIXTURE USED TO BE BUILT BY `spawnSync('zip', …)`, AND THAT IS WHY THE CHECK NEVER RAN
  // ON WINDOWS. windows-latest has no `zip.exe`, so the builder failed and the block below recorded
  // `check('archive import (skipped — no zip binary on this machine)', true)` — a PASS, on every
  // Windows run, over a code path nobody had executed (campaign E, finding E-W2). The one platform
  // where zip import was broken (MEM-73) was the one platform the check excused itself on.
  // writeZipSync is the project's own writer, so the fixture exists wherever Node does.
  writeZipSync(zip, [
    { name: 'kiln.md', data: readFileSync(join(src, 'kiln.md')) },
    { name: 'glaze.md', data: readFileSync(join(src, 'glaze.md')) }
  ]);
  {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'import-memories.js'), zip],
      { encoding: 'utf8', env: sb.env, cwd: ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const written = readdirSync(sb.env.MEMORY_DIR).filter((f) => f.endsWith('.md'));
    // 🟥 THE BUG THIS PINS. The CLI unzipped, looked for conversations.json, and exited with "is it
    // a ChatGPT export?" when it was absent — so a zip of markdown notes, which the README promises
    // is supported, imported NOTHING through the documented command while the library read it fine.
    // It also extracted with its own `unzip -o`, without the symlink guard the library carries.
    check('a zip of markdown notes imports its notes', written.length === 2,
      `wrote ${written.length}: ${written.join(', ')} | ${(r.stdout || '').slice(-180)}`);
    // MEM-73: and it does it with NO external binary in reach. An empty PATH removes `unzip`,
    // `tar` and everything else; the import must be unaffected, because lib/zip.js is in-process.
    const bare = spawnSync(process.execPath, [join(ROOT, 'scripts', 'import-memories.js'), zip],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
        env: { ...sb.env, MEMORY_DIR: join(sb.dir, 'mem2'), PATH: '', Path: '' } });
    const written2 = existsSync(join(sb.dir, 'mem2'))
      ? readdirSync(join(sb.dir, 'mem2')).filter((f) => f.endsWith('.md')) : [];
    check('...with an EMPTY PATH too — no unzip, no tar, no shell', written2.length === 2,
      `wrote ${written2.length} | ${(bare.stdout || bare.stderr || '').slice(-180)}`);
  }
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('two properties that would fail invisibly: incremental == full, and capture is time-independent');
{
  // 🟥 WHY THESE TWO. Both describe results that depend on HISTORY rather than on content. If either
  // broke, the corpus and the code would be identical and only the order of past operations would
  // differ — so a person would see wrong answers with nothing to point at. Found worth gating by a
  // stress round; scaled down here so the suite stays quick.

  // ---- incremental indexing must equal a full rebuild -------------------------------------
  const sb = sandbox();
  mkdirSync(sb.env.MEMORY_DIR, { recursive: true });
  const w = (n, d2, b) => writeFileSync(join(sb.env.MEMORY_DIR, n + '.md'),
    '---\nname: ' + n + '\ndescription: ' + d2 + '\n---\n\n' + b + '\n');
  for (let i = 0; i < 12; i++) w('base-' + i, 'workshop note ' + i,
    'The kiln fires at 1200 degrees for eight hours. Spoke tension is checked. Entry ' + i + '.');
  w('anodise', 'the anodising bath', 'The anodising bath is held at nineteen degrees for forty minutes.');
  // A SECTIONED MEMORY, so the fixture contains the shape where one FILE becomes several DOCUMENTS
  // (here: 7). Section children share their parent's `file`, which is why the incremental cache is
  // keyed by name.
  //
  // 🟥 THE HONEST BOUND ON THIS GATE. I tried four ways to make it fail by reintroducing the
  // historical name-vs-file reuse bug — keying the set by file, keying both set and get by file,
  // adding a sectioned document, and adding a query aimed at that document — and it passed every
  // time. So this gate demonstrably catches a writer that stops overwriting (mutation-tested) and
  // incremental/full divergence in general, but it has NOT been shown to catch that specific bug.
  // Recorded rather than claimed: a gate whose reach is unmeasured is a gate people over-trust.
  const para = 'The kiln is brought up in stages, holding at each plateau so the ware dries evenly ' +
               'and the glaze has time to settle before the next ramp begins. ';
  w('manual', 'the full firing manual',
    [1, 2, 3, 4, 5, 6].map((i) => '## Section ' + i + ' of the firing\n\n' + para.repeat(40)).join('\n\n'));

  const r = run(sb.env, `
    const { buildIndex } = await import(IDX);
    const { unlinkSync, writeFileSync } = await import('node:fs');
    const roots = [{ dir: process.env.MEMORY_DIR, corpus: 'curated', primary: true }];
    const QS = ['kiln fires at 1200 degrees', 'the anodising bath temperature', 'spoke tension checked',
                'the kiln is brought up in stages holding at each plateau'];
    const probe = async () => {
      const { search, invalidate } = await import(SRCH); invalidate();
      const o = {};
      for (const q of QS) { const x = await search(q, { limit: 6 });
        o[q] = (x.results||[]).map((y) => y.name + '|' + Number(y.score).toFixed(6)); }
      return o;
    };
    await buildIndex({ force: true, dir: roots, out: process.env.MEMORY_INDEX });
    for (let k = 0; k < 4; k++) {                       // adds, edits and a deletion, incrementally
      writeFileSync(process.env.MEMORY_DIR + '/added-' + k + '.md',
        '---\\nname: added-' + k + '\\ndescription: added in round ' + k + '\\n---\\n\\nRound ' + k + ' note about freehub engaging under load.\\n');
      writeFileSync(process.env.MEMORY_DIR + '/base-' + k + '.md',
        '---\\nname: base-' + k + '\\ndescription: workshop note ' + k + ' revised\\n---\\n\\nREVISED ' + k + '. The kiln fires at 1200 degrees. Spoke tension is checked.\\n');
      if (k > 1) { try { unlinkSync(process.env.MEMORY_DIR + '/added-' + (k - 2) + '.md'); } catch {} }
      await buildIndex({ force: false, dir: roots, out: process.env.MEMORY_INDEX });
    }
    const incr = await probe();
    await buildIndex({ force: true, dir: roots, out: process.env.MEMORY_INDEX });
    const full = await probe();
    out({ same: JSON.stringify(incr) === JSON.stringify(full),
          incr: incr[QS[0]] || [], full: full[QS[0]] || [] });`);
  check('an incrementally-built index ranks identically to a full rebuild', r.same === true,
    'incr ' + JSON.stringify(r.incr).slice(0, 110) + '  full ' + JSON.stringify(r.full).slice(0, 110));
  cleanupSandbox(sb.dir);

  // ---- capture must not depend on when it ran ---------------------------------------------
  const sb2 = sandbox();
  const SID = 'dddd1111-2222-3333-4444-555566667777';
  const dirA = join(sb2.dir, 'a'); const dirB = join(sb2.dir, 'b');
  const storeA = join(sb2.dir, 'store-a'); const storeB = join(sb2.dir, 'store-b');
  for (const p2 of [dirA, dirB, storeA, storeB]) mkdirSync(p2, { recursive: true });
  const uL = (t, ts) => JSON.stringify({ type: 'user', message: { role: 'user', content: t }, timestamp: ts });
  const aL = (t, ts) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, timestamp: ts });
  const lg = (x) => (x + ' ').repeat(45).trim();
  const txA = join(dirA, SID + '.jsonl');
  // SAME FILENAME in a different directory: the session id comes from the filename.
  const txB = join(dirB, SID + '.jsonl');
  const cap = (store, tx, timed) => spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'ingest-transcript.js'), tx, '--write', ...(timed ? ['--defer-last'] : [])],
    { encoding: 'utf8', env: { ...sb2.env, MEMORY_OWN_STORE: store }, cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true });

  writeFileSync(txA, '');
  for (let i = 0; i < 8; i++) {
    const t1 = new Date(Date.parse('2026-09-01T08:00:00Z') + i * 900000).toISOString();
    const t2 = new Date(Date.parse('2026-09-01T08:01:00Z') + i * 900000).toISOString();
    appendFileSync(txA, uL('question number ' + i, t1) + '\n' + aL(lg('Answer ' + i + ' about kiln temperature and glaze'), t2) + '\n');
    cap(storeA, txA, i % 2 === 1);                       // alternate hook and timed
  }
  appendFileSync(txA, uL('a closing question', '2026-09-02T09:00:00Z') + '\n');
  cap(storeA, txA, false);
  writeFileSync(txB, readFileSync(txA, 'utf8'));
  cap(storeB, txB, false);                               // captured ONCE, at the end

  const snap = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => f + '\u0000' + readFileSync(join(dir, f), 'utf8')).join('\u0001');
  const A = snap(storeA), B = snap(storeB);
  check('a transcript captured 9 times as it grew equals one captured once at the end',
    A === B, `${readdirSync(storeA).length} vs ${readdirSync(storeB).length} files; identical=${A === B}`);
  cleanupSandbox(sb2.dir);
}

// =============================================================================================
group('a memory that disappears is written down, not just warned about');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    const { buildIndex } = await import(IDX);
    const { unlinkSync, existsSync, readFileSync } = await import('node:fs');
    const roots = [{ dir: process.env.MEMORY_DIR, corpus: 'curated', primary: true }];
    await buildIndex({ dir: roots, out: process.env.MEMORY_INDEX });          // incremental path
    for (const f of ['winter-storage.md', 'workshop-rota.md']) unlinkSync(process.env.MEMORY_DIR + '/' + f);
    await buildIndex({ dir: roots, out: process.env.MEMORY_INDEX });          // the vanish path
    const sink = process.env.MEMORY_VANISH_LOG;
    const rows = existsSync(sink)
      // String.fromCharCode(10) rather than a newline escape: this runs inside an OUTER template
      // literal, which consumes \\n and \\r itself, so the child received a real line break and a
      // SyntaxError. Twice — once as a string escape, once inside a regex.
      ? readFileSync(sink, 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l)) : [];
    const last = rows[rows.length - 1] || {};
    out({ rows: rows.length, vanished: last.vanished, names: last.names || [],
          hasTime: typeof last.at === 'string', prev: last.previousDocs, now: last.currentDocs });`,
    );
  // The warning goes to stderr, which the hook host keeps nowhere. "When did those memories
  // disappear" is asked days later, so the record has to outlive the console.
  check('the disappearance is appended to a durable sink', r.rows === 1, JSON.stringify(r).slice(0, 200));
  check('...naming exactly what went', r.vanished === 2 &&
    ['winter-storage', 'workshop-rota'].every((n) => (r.names || []).includes(n)), JSON.stringify(r.names));
  check('...with a timestamp and the before/after counts',
    r.hasTime === true && r.prev === 16 && r.now === 14, JSON.stringify(r));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('a server adopts an index another process rebuilt');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { search } = await import(SRCH);
    await search('how do I bleed the brakes', { limit: 3 });        // caches the index in THIS process
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.MEMORY_DIR + '/late-arrival.md',
      '---\\nname: late-arrival\\ndescription: added after the index was cached\\n---\\n\\nThe KANGAROO procedure is written down here.\\n');
    // ANOTHER process rebuilds — the real shape, because an in-process rebuild clears the cache itself.
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, ['--input-type=module', '-e',
      "const {buildIndex}=await import(" + JSON.stringify(IDX) + ");" +
      "await buildIndex({force:true,dir:[{dir:process.env.MEMORY_DIR,corpus:'curated',primary:true}],out:process.env.MEMORY_INDEX});"],
      { encoding: 'utf8', env: process.env, windowsHide: true });
    const after = await search('KANGAROO procedure', { limit: 5 });
    out({ found: (after.results || []).some((x) => x.name === 'late-arrival'),
          reloaded: after.indexReloadedFromDisk === true });`);
  check('a memory indexed by ANOTHER process is found without a restart', r.found === true,
    JSON.stringify(r).slice(0, 200));
  check('...and the response says the index was re-read', r.reloaded === true, JSON.stringify(r));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('writing to a memory folder — the one guarded door');
{
  const sb = sandbox();
  const dir = sb.env.MEMORY_DIR; mkdirSync(dir, { recursive: true });
  const ORIGINAL = '---\nname: subject\ndescription: a memory to edit\n---\n\nEvery word of this body matters.\n';
  writeFileSync(join(dir, 'subject.md'), ORIGINAL);
  const r = run(sb.env, `
    const SW = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'safe-write.js')).href)});
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const p = process.env.MEMORY_DIR + '/subject.md';
    const original = readFileSync(p, 'utf8');

    // 1. a frontmatter-only edit is allowed, and snapshots the previous bytes
    const ok = SW.rewriteFrontmatterOnly(p, original.replace('description: a memory to edit',
      'description: a memory to edit\\nmetadata:\\n  tier: archive'));
    const snapDir = process.env.MEMORY_DIR + '/' + SW.SNAPSHOT_DIR;
    // 2. an edit that would change the BODY must be refused
    const bad = SW.rewriteFrontmatterOnly(p, original.replace('Every word of this body matters.', 'MANGLED.'));
    // 3. a truncating write must be refused
    const trunc = SW.rewriteFrontmatterOnly(p, original.slice(0, 40));
    out({ wrote: ok.written === true,
          snapshotKept: existsSync(snapDir) && readdirSync(snapDir).length > 0,
          bodyRefused: bad.written !== true,
          truncRefused: trunc.written !== true,
          bodyIntact: SW.bodyOf(readFileSync(p, 'utf8')).trim() === 'Every word of this body matters.',
          snapshotsPerFile: SW.SNAPSHOTS_PER_FILE });`);
  check('a frontmatter-only edit is written', r.wrote === true, JSON.stringify(r).slice(0, 200));
  check('...and the previous bytes are snapshotted first', r.snapshotKept === true);
  check('an edit that would change the BODY is refused', r.bodyRefused === true);
  check('a truncating write is refused', r.truncRefused === true);
  check('the body is byte-identical after all of it', r.bodyIntact === true);
  check('the snapshot count can never be configured below 1', r.snapshotsPerFile >= 1, String(r.snapshotsPerFile));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('read-only mode writes nothing at all');
{
  const mk = (d) => { mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'subject.md'), '---\nname: subject\ndescription: d\n---\n\nBody.\n'); };
  const probe = (readOnly) => {
    const sb = sandbox(readOnly ? { MEMORY_CURATED_READ_ONLY: '1' } : {});
    mk(sb.env.MEMORY_DIR);
    const r = run(sb.env, `
      const { existsSync, readdirSync } = await import('node:fs');
      const memory = await memoryTool();
      const res = await memory({ action: 'demote', name: 'subject' });
      const SW = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'safe-write.js')).href)});
      const snapDir = process.env.MEMORY_DIR + '/' + SW.SNAPSHOT_DIR;
      out({ changed: res.changed === true,
            snapshots: existsSync(snapDir) ? readdirSync(snapDir).length : 0 });`);
    cleanupSandbox(sb.dir);
    return r;
  };
  const on = probe(false), off = probe(true);
  // The control matters: without it, "nothing changed" proves nothing about read-only mode.
  check('CONTROL: with writes allowed, demote actually changes something', on.changed === true, JSON.stringify(on));
  check('...and snapshots the previous version', on.snapshots > 0, JSON.stringify(on));
  check('MEMORY_CURATED_READ_ONLY=1 refuses the write', off.changed === false, JSON.stringify(off));
  check('...and writes no snapshot either', off.snapshots === 0, JSON.stringify(off));
}


// =============================================================================================
group('import: a dry run reports in the future tense, and a write refuses an argument it does not know');
// Two measured defects, both a response claiming something untrue. `dryRun:true` — a typo for
// `dry` — used to IMPORT FOR REAL, because zod strips unknown keys and the flag was deleted before
// the handler ran. And `dry:true` reported `written: 3`, naming three files that did not exist.
{
  const sb = sandbox();
  const src = join(sb.dir, 'src');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(src, `note-${i}.md`),
      `# Note ${i}\n\nA sentence comfortably past the forty-character floor the importer applies, numbered ${i}.\n`);
  }
  const r = run(sb.env, `
    const { readdirSync, existsSync, mkdirSync } = await import('node:fs');
    const memory = await memoryTool();
    const SRC = ${JSON.stringify(src)};
    mkdirSync(process.env.MEMORY_DIR, { recursive: true });
    const md = () => readdirSync(process.env.MEMORY_DIR).filter((f) => f.endsWith('.md'));
    const typo  = await memory({ action: 'import', path: SRC, dryRun: true });
    const afterTypo = md().length;
    const dry   = await memory({ action: 'import', path: SRC, dry: true });
    const afterDry = md().length;
    const real  = await memory({ action: 'import', path: SRC, dry: false });
    const stray = await memory({ action: 'search', query: 'anything', notAnArgument: 1 });
    out({ typoErr: String(typo.error || ''), afterTypo,
          dryWritten: dry.written, dryWould: dry.wouldWrite, dryHasPastTense: 'writtenNames' in dry, afterDry,
          realWritten: real.written, realNames: (real.writtenNames || []).length, realHasFuture: 'wouldWrite' in real,
          onDisk: md().length, strayErr: String(stray.error || '') });`);
  check('a `dryRun` typo on import is REFUSED, naming the key and the one that was meant',
    /unknown argument/.test(r.typoErr) && /'dryRun'/.test(r.typoErr) && /'dry'/.test(r.typoErr), r.typoErr.slice(0, 180));
  check('...and nothing was written', r.afterTypo === 0, String(r.afterTypo));
  check('CONTROL: the correct flag is a dry run that says written: 0', r.dryWritten === 0 && r.dryWould === 3,
    JSON.stringify({ written: r.dryWritten, wouldWrite: r.dryWould }));
  check('...and carries no past-tense field at all', r.dryHasPastTense === false);
  check('...and still wrote nothing', r.afterDry === 0, String(r.afterDry));
  check('CONTROL: the real import writes and reports in the PAST tense',
    r.realWritten === 3 && r.realNames === 3 && r.realHasFuture === false && r.onDisk === 3, JSON.stringify(r));
  check('a stray argument on a READ action is still tolerated', !/unknown argument/.test(r.strayErr), r.strayErr.slice(0, 120));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('the store is truth — a file the index has not read yet is served, and the secret gates hold');
// A captured exchange can be on disk seconds before any index rebuild sees it. `latest` must return
// it (read directly from the store, provenance 'unindexed-direct'); `search` must LIST it beside the
// ranking, never IN it; and a file the indexer would refuse — `metadata.secret: true`, or a
// denylisted filename — must never surface through the direct path either. Kill switch:
// MEMORY_UNINDEXED_DIRECT=0 restores warn-only, and over a current index nothing changes at all.
{
  // 🟥 THIS TEST SUPPLIES ITS OWN DENYLIST, and must. It used to name a fixture after an entry in
  // the SHIPPED secrets-exclude.json, which coupled a supposedly self-contained check to one
  // machine's configuration. The release build strips per-machine entries -- correctly: they name
  // real private files -- so `excludeFiles` is empty in the published tree, `isDenylistedFile()`
  // returned false, and SEVEN checks failed on a fresh clone, one of them printing "leaks": true,
  // which reads as a security incident and is nothing of the kind. Measured 2026-09-07: the built
  // public tree scored 238/7 on macOS AND Linux; restoring one entry made it 245/0.
  //
  // scripts/verify-stdio.js had exactly this bug and was fixed the same way -- MEMORY_SECRETS_CONFIG
  // exists for it. A test that depends on the author's configuration is not a test of the software.
  const denyDir = mkdtempSync(join(tmpdir(), 'recall-deny-'));
  const denyCfg = join(denyDir, 'secrets-exclude.json');
  writeFileSync(denyCfg, JSON.stringify({
    _comment: 'Written by run-public-tests.js. Exercises the filename denylist against a fixture.',
    excludeFiles: ['fixture-denylisted-file.md'],
    sectionScrub: {},
    patterns: [],
    tokenHashesSha256: []
  }, null, 2) + '\n');
  const sb = sandbox({ MEMORY_SECRETS_CONFIG: denyCfg });
  copyFixtures(sb.env.MEMORY_DIR);
  const store = sb.env.MEMORY_OWN_STORE;
  const SID = 'aaaa3333-0000-0000-0000-000000000000';
  const exch = (n, ts, desc, body, extraMeta = '') =>
    `---\nname: ${n}\ndescription: "${desc}"\nmetadata:\n  type: exchange\n  sessionId: ${SID}\n  ts: ${ts}\n${extraMeta}---\n\n**Asked:** ${desc}\n\n${body}\n`;
  writeFileSync(join(store, 'x-aaaa3333-20260905T010000000Z.md'), exch('x-aaaa3333-20260905T010000000Z', '2026-09-05T01:00:00.000Z',
    'first exchange about the freehub pubtopic33', 'The freehub service procedure: the pawls need grease. pubtopic33 appears here with several more sentences of ordinary workshop prose.'));
  writeFileSync(join(store, 'x-aaaa3333-20260905T020000000Z.md'), exch('x-aaaa3333-20260905T020000000Z', '2026-09-05T02:00:00.000Z',
    'second exchange about chain wear pubtopic33', 'Chain wear limits: replace at 0.75 percent stretch. pubtopic33 again, with prose about the measuring tool.'));
  const CFG = JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'config.js')).href);
  const buildStaging = `const { buildIndex } = await import(IDX); const C = await import(${CFG});
    const r = await buildIndex({ force: true, dir: C.rootsForCorpus('staging'), out: C.stagingIndexPath() });`;
  const built = run(sb.env, `${buildStaging} out({ filesIndexed: r.filesIndexed });`);
  check('the staging fixture indexed 2 exchanges', built.filesIndexed === 2, JSON.stringify(built));
  spawnSync('sleep', ['1'], { windowsHide: true });

  const TOKEN = 'pubtok-9x3-direct';
  writeFileSync(join(store, 'x-aaaa3333-20260905T030000000Z.md'), exch('x-aaaa3333-20260905T030000000Z', '2026-09-05T03:00:00.000Z',
    `third exchange, not yet indexed, about the derailleur pubtopic33 ${TOKEN}`,
    `The unique token ${TOKEN} lives only in this exchange. We straightened the derailleur hanger. pubtopic33 is mentioned too.`));
  writeFileSync(join(store, 'x-aaaa3333-20260905T031500000Z.md'), exch('x-aaaa3333-20260905T031500000Z', '2026-09-05T03:15:00.000Z',
    `a secret-marked exchange that also says ${TOKEN}`, `hidden-secret-body with ${TOKEN} that must never surface.`, '  secret: true\n'));
  // Denylisted by the sandbox config written above, never by whatever this install happens to list.
  writeFileSync(join(store, 'fixture-denylisted-file.md'), exch('fixture-denylisted-file', '2026-09-05T03:30:00.000Z',
    `a denylisted file that also says ${TOKEN}`, `denylisted-body with ${TOKEN} — must never surface if the denylist names this file.`));

  const r = run(sb.env, `
    const S = await import(${CFG.replace('config.js', 'secrets.js')});
    const memory = await memoryTool();
    const lat = await memory({ action: 'latest', query: ${JSON.stringify(TOKEN)}, scope: 'staging' });
    const top = await memory({ action: 'latest', query: 'pubtopic33', scope: 'staging', limit: 5 });
    const srch = await memory({ action: 'search', query: ${JSON.stringify(TOKEN + ' derailleur')}, scope: 'staging', limit: 5 });
    out({ denylisted: S.isDenylistedFile('fixture-denylisted-file.md'),
          latNames: (lat.results || []).map((x) => [x.name, x.provenance || 'idx']),
          latChecked: lat.unindexedChecked || null, latVoid: !!lat.recencyVoid,
          topNames: (top.results || []).map((x) => x.name), topVoid: !!top.recencyVoid,
          srchNames: (srch.results || []).map((x) => x.name),
          srchRecent: srch.recentUnindexed || null,
          leaks: [JSON.stringify(lat), JSON.stringify(top), JSON.stringify(srch)].some((t) => /hidden-secret-body|denylisted-body/.test(t)),
          // MEM-41: not the BODY (above) but the NAME. A gated file may not be listed, matched or
          // quoted-about by any channel, on any of the three actions.
          namesGated: [JSON.stringify(lat), JSON.stringify(top), JSON.stringify(srch)]
            .some((t) => /fixture-denylisted|20260905T031500000Z/.test(t)),
          gatedFiles: lat.gatedFiles ?? null,
          // A plain substring, not a regex: this string lives in a TEMPLATE LITERAL, so \( would be
          // unescaped to ( before the child ever compiled it, and the test would silently be for
          // "files are EXCLUDED" — a group, not a literal — and always false.
          warnWithheld: String(lat.staleWarning || '').includes('are EXCLUDED from this index'),
          stillStale: lat.indexStale === true });`);
  check('latest RETURNS the unindexed exchange as results[0], read straight from the store',
    r.latNames?.[0]?.[0] === 'x-aaaa3333-20260905T030000000Z' && r.latNames?.[0]?.[1] === 'unindexed-direct', JSON.stringify(r.latNames));
  check('the secret-marked file never surfaces, and no gated body text leaks through any response',
    !(r.latNames || []).some((x) => x[0] === 'x-aaaa3333-20260905T031500000Z') && !(r.topNames || []).includes('x-aaaa3333-20260905T031500000Z') && r.leaks === false,
    JSON.stringify({ lat: r.latNames, top: r.topNames, leaks: r.leaks }));
  check('the denylisted filename never surfaces (when this install denylists it)',
    r.denylisted !== true || (!(r.latNames || []).some((x) => x[0] === 'fixture-denylisted-file') && !(r.topNames || []).includes('fixture-denylisted-file')),
    JSON.stringify({ denylisted: r.denylisted, lat: r.latNames, top: r.topNames }));
  check('unindexedChecked says the check happened (3 scanned, 1 merged, the gated ones excluded)',
    r.latChecked?.scanned === 3 && r.latChecked?.merged === 1 && r.latChecked?.excluded === (r.denylisted ? 2 : 1), JSON.stringify(r.latChecked));
  check('on a topic word the unread exchange is ORDERED FIRST and no recency warning fires (it was read)',
    r.topNames?.[0] === 'x-aaaa3333-20260905T030000000Z' && r.topVoid === false, JSON.stringify({ top: r.topNames, void: r.topVoid }));
  check('search does NOT rank the unindexed exchange but LISTS it under recentUnindexed',
    !(r.srchNames || []).includes('x-aaaa3333-20260905T030000000Z') && r.srchRecent?.count === 1 && r.srchRecent?.files?.[0]?.name === 'x-aaaa3333-20260905T030000000Z',
    JSON.stringify({ ranked: r.srchNames, recent: r.srchRecent }).slice(0, 300));
  // MEM-41 / big-test P-1. The gates stopped every BODY and none of the NAMES: asked for a token
  // that lives in the denylisted file, the server used to answer "gatedtoken55 appears in
  // store/fixture-denylisted-file.md" and tell the reader to open it — the disclosure the
  // denylist exists to prevent, made by the honesty layer, on latest, search and sessions alike.
  check('a gated file is never NAMED either — not in a list, a warning, or a guidance line',
    r.namesGated === false, JSON.stringify({ lat: r.latNames, recent: r.srchRecent }).slice(0, 300));
  check('...and the response says HOW MANY were withheld, and why, without saying which',
    r.gatedFiles === (r.denylisted ? 2 : 1) && r.warnWithheld === true,
    JSON.stringify({ gatedFiles: r.gatedFiles, denylisted: r.denylisted, warn: r.warnWithheld }));
  check('...while the index is still reported stale — a gated file is withheld, not forgotten',
    r.stillStale === true && r.latChecked?.excluded === (r.denylisted ? 2 : 1),
    JSON.stringify({ stale: r.stillStale, checked: r.latChecked }));

  // MUTATION — the kill switch. Nothing is read; the original warn-only guards must fire instead.
  const off = run({ ...sb.env, MEMORY_UNINDEXED_DIRECT: '0' }, `
    const memory = await memoryTool();
    const lat = await memory({ action: 'latest', query: ${JSON.stringify(TOKEN)}, scope: 'staging' });
    const top = await memory({ action: 'latest', query: 'pubtopic33', scope: 'staging', limit: 5 });
    out({ latRows: (lat.results || []).length, named: JSON.stringify(lat.foundInUnindexed || {}).includes('20260905T030000000Z'),
          topVoid: !!top.recencyVoid, disabled: lat.unindexedChecked?.disabled || null,
          // The leaking channel was the CONTENT SCAN, not the direct read, so it survived the kill
          // switch: this is the arm that actually reproduced P-1.
          namesGated: [JSON.stringify(lat), JSON.stringify(top)].some((t) => /fixture-denylisted|20260905T031500000Z/.test(t)) });`);
  check('[kill switch] nothing is returned for the token — but the content scan still NAMES the file', off.latRows === 0 && off.named === true, JSON.stringify(off));
  check('[kill switch] ...the ORDINARY file only: with the direct read off, the gated ones are still not named',
    off.named === true && off.namesGated === false, JSON.stringify(off));
  check('[kill switch] the topic query warns: recencyVoid fires', off.topVoid === true, JSON.stringify(off));
  check('[kill switch] the response says the direct read was disabled', off.disabled === 'MEMORY_UNINDEXED_DIRECT=0', JSON.stringify(off));

  // CONTROL — rebuild so nothing is unindexed: no direct rows, no unindexedChecked, kill switch irrelevant.
  const ctl = run(sb.env, `${buildStaging}
    const memory = await memoryTool();
    const a = await memory({ action: 'latest', query: 'pubtopic33', scope: 'staging', limit: 5 });
    out({ indexed: r.filesIndexed, hasChecked: 'unindexedChecked' in a, direct: (a.results || []).filter((x) => x.provenance === 'unindexed-direct').length,
          keys: Object.keys(a).sort() });`);
  const ctlOff = run({ ...sb.env, MEMORY_UNINDEXED_DIRECT: '0' }, `
    const memory = await memoryTool();
    const a = await memory({ action: 'latest', query: 'pubtopic33', scope: 'staging', limit: 5 });
    out({ keys: Object.keys(a).sort() });`);
  check('[control] the rebuild indexed the 3 legitimate exchanges and refused the gated ones', ctl.indexed === 3, JSON.stringify(ctl.indexed));
  check('[control] over a current index there is no unindexedChecked and no unindexed-direct row', ctl.hasChecked === false && ctl.direct === 0, JSON.stringify(ctl));
  check('[control] ...and the kill switch changes no field at all', JSON.stringify(ctl.keys) === JSON.stringify(ctlOff.keys), JSON.stringify({ on: ctl.keys, off: ctlOff.keys }));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
// The shippable third of the recent-recall stress harness (test/recall-stress/ is private).
// It kills a real capture run mid-way and asks the real handler what it says about the gap.
{
  const { recallStressLite } = await import('./recall-stress-lite.mjs');
  await recallStressLite({ check, group, sandbox });
}

// =============================================================================================
// A LOADED SERVER KEEPS TIME. The one check in this suite that starts the real MCP server and then
// waits — because the claim is about what happens while nobody is doing anything. It is here, in
// the public suite, PRECISELY so it runs on windows-latest: the 5-minute capture walk used to come
// from a macOS LaunchAgent, so on Windows it never ran at all, and a Windows-shaped feature proved
// only on a Mac is not proved. Budget: ~15 s, dominated by the deliberate 12 s control.
// =============================================================================================
// WHERE A PACKAGE INSTALL WRITES ITS STATE. Cheap (subprocesses, no model, no index) and placed
// before the slow end-to-end checks so a broken resolver fails fast.
// =============================================================================================
// EVERY ADVERTISED FORMAT MUST ACTUALLY BE READABLE.
//
// 🟥 THE BUG THIS PINS, found by importing a plain JSON file into the PUBLISHED 1.8.0 package.
// supportedExtensions() listed '.json', and the only .json the reader could actually handle was a
// ChatGPT export. Everything else fell through to `skip: unsupported format .json` — so one
// response said, simultaneously: shape "JSON (read as text)", skippedUnreadable "unsupported
// format .json", and supportedFormats [... ".json" ...]. Advertised and refused at once.
//
// The specific fix was one branch. THIS is the general one: the advertised list and the reader
// are two places that have to agree, and nothing made them. A format may still legitimately be
// refused for a MISSING CONVERTER (textutil is macOS-only, pdftotext may not be installed) —
// that refusal names the tool and is a different thing from "I do not know this extension".
{
  group('(fmt) the advertised format list vs what the reader will actually read');
  const { supportedExtensions, readSource } = await import('../../lib/import-sources.js');
  const exts = supportedExtensions();
  check('(fmt) CONTROL — the list is non-trivial', exts.length >= 10, `${exts.length} formats`);

  const sample = {
    '.md': '# Note\n\nWedge the clay twice before throwing.\n',
    '.markdown': '# Note\n\nWedge the clay twice.\n',
    '.txt': 'Wedge the clay twice before throwing.\n',
    '.text': 'Wedge the clay twice before throwing.\n',
    '.log': 'Wedge the clay twice before throwing.\n',
    '.csv': 'item,rule\nkiln,cool overnight or the glaze crazes\n',
    '.tsv': 'item\trule\nkiln\tcool overnight or the glaze crazes\n',
    '.json': '{"rule":"cool the kiln overnight or the glaze crazes"}\n',
    '.html': '<html><body><p>Cool the kiln overnight or the glaze crazes.</p></body></html>',
    '.htm': '<html><body><p>Cool the kiln overnight or the glaze crazes.</p></body></html>'
  };

  const unknownExtension = [];
  for (const ext of exts) {
    if (!(ext in sample)) continue;            // binary formats need real fixtures, not a string
    const d = mkdtempSync(join(tmpdir(), 'fmt-'));
    const f = join(d, `probe${ext}`);
    writeFileSync(f, sample[ext]);
    let why = '';
    try {
      const r = readSource(f, {});
      const skips = (r.skipped || []).map((x) => x.why || '').join(' ');
      const got = (r.items || []).length;
      // "unsupported format" means the reader does not know the extension at all. A converter
      // that is missing is a DIFFERENT refusal and stays allowed here.
      if (got === 0 && /unsupported format/i.test(skips)) why = skips;
    } catch (e) { why = String(e.message).slice(0, 60); }
    cleanupSandbox(d, { label: 'fmt' });
    if (why) unknownExtension.push(`${ext}: ${why}`);
  }
  check('(fmt) no advertised format is refused as an unknown extension',
    unknownExtension.length === 0, unknownExtension.join(' | '));
}

// =============================================================================================
// index_status — NOT COVERED HERE, DELIBERATELY, AND THE REASON IS WORTH THE SPACE.
//
// 1.8.2 made the no-jobId form mirror the newest job's fields at the top level, because the two
// forms previously disagreed about where `state` lived and a poller written for one never saw
// `done` in the other (three false timeouts, measured on a Windows install).
//
// A check was written for it here and REMOVED after mutation testing, because it was vacuous: in
// this suite no index job has ever run, so `jobs` is empty, the mirror contributes nothing, and
// the assertion on `note` matched the "No index job has run in this process." branch whether the
// fix was present or not. Two separate mutations — dropping the mirror entirely, and reverting the
// note wording — both SURVIVED it.
//
// Covering it honestly needs a real index job in-process, which needs the embedding model; that is
// what test/public/e2e-index-and-search.mjs is for and where it belongs if it is added. Until then
// the fix rests on a live stdio probe (both forms reported state `done`), and saying so is better
// than a green check that proves nothing.

// =============================================================================================
// A MEMORY FOLDER'S OWN CLUTTER MUST NOT BECOME DOCUMENTS.
//
// 🟥 WHY THIS IS PINNED. A real memory folder accumulates two things beside the memories: the
// server's own `.memory-snapshots/` undo history, and editor/backup leftovers like `foo.md.bak`.
// Both are OLD COPIES of current memories. Indexed, they do not merely add noise — they compete
// with the live version for the same query, so a search can return the superseded text with a
// confident score. That is the exact failure this project exists to prevent, arriving through
// the back door.
//
// Today they are excluded by two INCIDENTAL facts, neither of them stated as a rule: the loader
// filters on `.md` (so `.md.bak` misses), and it reads the directory FLAT (so a subfolder is
// never entered). Nothing said that was deliberate. "Support subfolders in the memory dir" is a
// reasonable-sounding feature request that would silently index every snapshot on every machine.
//
// Found while building a memories archive for another machine: 63 snapshot files and a 380 KB
// .bak had to be stripped by hand. The archive was the bug; this checks the SERVER never had it.
{
  group('(clutter) snapshots and .bak files are not documents');
  const { loadCorpus } = await import('../../lib/corpus.js');
  const d = mkdtempSync(join(tmpdir(), 'clutter-'));
  mkdirSync(join(d, '.memory-snapshots'), { recursive: true });
  const fm = (name, desc, body) =>
    `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: reference\n---\n${body}\n`;
  writeFileSync(join(d, 'wheel-truing.md'),
    fm('wheel-truing', 'current', 'Spoke tension is 100 kgf on the drive side.'));
  writeFileSync(join(d, '.memory-snapshots', 'wheel-truing.20260101T000000Z.md'),
    fm('wheel-truing', 'OBSOLETE SNAPSHOT', 'Spoke tension is 80 kgf. THIS IS SUPERSEDED.'));
  writeFileSync(join(d, 'wheel-truing.md.bak'),
    fm('wheel-truing', 'BAK LEFTOVER', 'Spoke tension is 50 kgf. THIS IS A BACKUP FILE.'));

  // 🟥 A STRING, NOT AN ARRAY. loadCorpus(['/dir']) returns ZERO documents silently — an array
  // is read as a root-descriptor list, not a list of paths. The first version of this check
  // passed it an array, loaded nothing, and both exclusion assertions went GREEN on an empty
  // corpus. Only the CONTROL below caught it. That is what the control is for.
  let docs = [];
  try { docs = (loadCorpus(d).docs) || []; } catch (e) { docs = []; }
  const blob = JSON.stringify(docs);

  check('(clutter) CONTROL — the real memory IS loaded (or the rest is vacuous)',
    /100 kgf/.test(blob), `${docs.length} doc(s)`);
  check('(clutter) a .memory-snapshots/ copy is NOT indexed',
    !/SUPERSEDED|OBSOLETE SNAPSHOT/.test(blob), 'a superseded snapshot became a document');
  check('(clutter) a .md.bak leftover is NOT indexed',
    !/BACKUP FILE|BAK LEFTOVER/.test(blob), 'an editor backup became a document');
  check('(clutter) exactly ONE document came out of a folder holding three files',
    docs.length === 1, `${docs.length} doc(s): ${docs.map((x) => x.name).join(', ')}`);
  cleanupSandbox(d, { label: 'clutter' });
}

{
  const { readToolCannotWriteTests } = await import('./read-tool-cannot-write.mjs');
  await readToolCannotWriteTests({ check, group });
}

{
  const { dreamWritesNowhereTests } = await import('./dream-writes-nowhere.mjs');
  await dreamWritesNowhereTests({ check, group });
}

{
  const { cliFlagsTests } = await import('./cli-flags.mjs');
  await cliFlagsTests({ check, group });
}

{
  const { stateRootTests } = await import('./state-root.mjs');
  await stateRootTests({ check, group });
}

{
  const { handoffReachableTests } = await import('./handoff-reachable.mjs');
  await handoffReachableTests({ check, group });
}

{
  const { schedulerE2E } = await import('./scheduler-e2e.mjs');
  await schedulerE2E({ check, group });
}

// =============================================================================================
// MEM-67 — THE LAST EXCHANGE OF A HOOK-LESS INSTALL. The sibling of the check above, and the one
// the Windows PC test of 1.7.1 asked for: the timer used to defer the in-flight exchange on every
// tick, so the newest thing in a chat reached the store only when the hourly audit healed it (~14
// min measured, ~75 worst case). Public for the same reason as the scheduler check — Windows is
// where no Stop hook exists, so Windows is where the defect lives. Budget: ~15 s.
{
  const { inflightQuietCaptureE2E } = await import('./inflight-quiet-capture-e2e.mjs');
  await inflightQuietCaptureE2E({ check, group });
}

// =============================================================================================
// MEM-77 / MEM-78 / MEM-80 — THE 1.7.3 CAPTURE FIXES, in the hook-less configuration the Windows PC
// actually ran. The sibling above proves an ABANDONED turn is captured after ten minutes of
// silence; this one proves a FINISHED turn is captured on the next tick with no wait at all, that
// the flag warning "this may be a draft" is no longer on every capture ever made, that an exchange
// whose fact is in the ASK survives the short-reply floor, and that a scheduled-task session beside
// it takes neither a slot nor a store file. Windows again, and for the same reason: no Stop hook
// there, so the defect lives there. Budget: ~20 s.
{
  const { finishedTurnCaptureE2E } = await import('./finished-turn-capture-e2e.mjs');
  await finishedTurnCaptureE2E({ check, group });
}

// =============================================================================================
// THE AUDIT TICK (MEM-50). The channel that compares the TRANSCRIPT to the STORE — the only one a
// lying debounce stamp cannot fool, which is what MEM-39 turned out to need. Here, and not in the
// private suite, because it spawns a writer and takes a lock: both were silently broken on Windows
// in the last release (MEM-38 #1, #2, #3), and a repair path proved only on a Mac is not proved.
{
  const { storeAuditTick } = await import('./store-audit-tick.mjs');
  await storeAuditTick({ check, group });
}

// =============================================================================================
// The OTHER half of that claim, and the half a fresh install actually experiences: capture having
// run is worth nothing if the running server cannot then read it. scheduler-e2e loads the staging
// scope only AFTER the index exists, which is the one order in which A-D1 cannot bite; this loads
// it first, the way a real conversation does. Windows matters here for the same reason: this is
// the platform where the first index is most likely to arrive while a server is already up.
// Budget: ~20 s.
{
  const { freshInstallE2E } = await import('./fresh-install-e2e.mjs');
  await freshInstallE2E({ check, group });
}

// =============================================================================================
// IMPORT -> INDEXED, and a zip that needs no binary (MEM-72 / MEM-73). Here rather than in the
// private suite for one reason: the only Windows-relevant check on this path used to SKIP itself
// on windows-latest for want of the `zip` writer, so the platform where zip import was broken was
// the platform nothing ran on. Every fixture below is built in Node. Budget: ~20 s (one real
// index build over three documents).
{
  const { importIndexE2E } = await import('./import-index-e2e.mjs');
  await importIndexE2E({ check, group, sandbox, run });
}

// =============================================================================================
// THE CAMPAIGN, LITE — blocks A / B.1 / B.3 / B.4 / C.2 of the 1.7.1 test campaign, sandboxed.
//
// OFF BY DEFAULT, and that is a deliberate trade rather than an oversight. This suite is the gate
// every push waits for and its budget is a couple of minutes; campaign-lite soaks a real server
// for ten. So it runs behind MEMORY_PUBLIC_CAMPAIGN=1 — set by its own CI job, on windows-latest
// and macos-latest, on the release branches — and by anyone who wants the deeper pass locally:
//
//   MEMORY_PUBLIC_CAMPAIGN=1 npm run test:full        or        node test/public/campaign-lite.mjs
if (process.env.MEMORY_PUBLIC_CAMPAIGN === '1') {
  const { campaignLite } = await import('./campaign-lite.mjs');
  await campaignLite({ check, group });
} else {
  group('campaign-lite (A / B.1 / B.3 / B.4 / C.2)');
  console.log('  skipped — set MEMORY_PUBLIC_CAMPAIGN=1 to run it (~10 minutes). Its own CI job does.');
}

// =============================================================================================
group('an array scope may not drop what a named scope carries');
// MEM-27: `latest` with an ARRAY scope copied five keys out of each named-scope response and
// dropped the rest — indexStale, staleWarning, recencyVoid, unindexedChecked, premiseSupported —
// and skipped empty sections entirely, so a corpus that was stale AND matched nothing could not
// even be named. The contract: every key a NAMED scope carries reappears at the wrapper top level,
// in that corpus's own section, or in the AGGREGATED_AS allowance below.
{
  const sb = sandbox({ MEMORY_LIBRARY: '0' });
  copyFixtures(sb.env.MEMORY_DIR);
  const store = sb.env.MEMORY_OWN_STORE;
  const SID = 'cccc7575-0000-0000-0000-000000000000';
  const TOPIC = 'invtopicpub';
  const exch = (n, ts, desc, body) =>
    `---\nname: ${n}\ndescription: "${desc}"\nmetadata:\n  type: exchange\n  sessionId: ${SID}\n  ts: ${ts}\n---\n\n**Asked:** ${desc}\n\n${body}\n`;
  writeFileSync(join(store, 'x-cccc7575-20260905T010000000Z.md'), exch('x-cccc7575-20260905T010000000Z', '2026-09-05T01:00:00.000Z',
    `pawls grease ${TOPIC}`, `The pawls need light oil, not grease. ${TOPIC} appears here with several more sentences of workshop prose.`));
  writeFileSync(join(store, 'x-cccc7575-20260905T020000000Z.md'), exch('x-cccc7575-20260905T020000000Z', '2026-09-05T02:00:00.000Z',
    `chain wear ${TOPIC}`, `Chain wear limits: replace at 0.75 percent stretch. ${TOPIC} again, with prose about the measuring tool.`));
  const CFG = JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'config.js')).href);

  // Keys a named scope carries that are deliberately NOT reproduced per section, each with the
  // reason. Hand-maintained: a new field is a decision here, or a failure below.
  // (lastIngestAt, termFrequencies, termFrequenciesWholeWord, matchedTermsPerDoc were allowed to drop
  // here until 2026-09-05; they now travel in SECTION_KEYS, because each backs a claim the section carries.)
  const AGGREGATED_AS = ['indexPath', 'indexCheckMs', 'indexCheckedFiles', 'newestSourceModified',
    'staleNewestModified', 'staleFilesRemoved', 'modifiedFieldNote', 'corpusProfile', 'corpusCurrency',
    'summariesDemoted'];

  const r = run(sb.env, `
    const { buildIndex } = await import(IDX); const C = await import(${CFG});
    await buildIndex({ force: true, dir: C.rootsForCorpus('curated'), out: C.indexPath() });
    const b = await buildIndex({ force: true, dir: C.rootsForCorpus('staging'), out: C.stagingIndexPath() });
    const memory = await memoryTool();
    const Q = ${JSON.stringify(TOPIC + ' chain wear')};
    const cur = await memory({ action: 'latest', query: Q, scope: 'curated', limit: 3 });
    const stg = await memory({ action: 'latest', query: Q, scope: 'staging', limit: 3 });
    const arr = await memory({ action: 'latest', query: Q, scope: ['curated', 'staging'], limit: 3 });
    const onlyStaging = await memory({ action: 'latest', query: ${JSON.stringify(TOPIC)}, scope: ['curated', 'staging'], limit: 3 });
    out({ stgIndexed: b.filesIndexed,
          curKeys: Object.keys(cur), stgKeys: Object.keys(stg),
          topKeys: Object.keys(arr),
          sections: (arr.sections || []).map((s) => ({ corpus: s.corpus, keys: Object.keys(s) })),
          emptySection: (onlyStaging.sections || []).find((s) => s.corpus === 'curated') || null,
          stagingAnswered: ((onlyStaging.sections || []).find((s) => s.corpus === 'staging')?.results || []).length });`);

  check('the two-corpus fixture built', r.stgIndexed === 2 && (r.curKeys || []).length > 8, JSON.stringify({ stg: r.stgIndexed, cur: (r.curKeys || []).length }));
  for (const [corpus, keys] of [['curated', r.curKeys], ['staging', r.stgKeys]]) {
    const sec = (r.sections || []).find((s) => s.corpus === corpus);
    const missing = (keys || []).filter((k) => !(r.topKeys || []).includes(k) && !(sec?.keys || []).includes(k) && !AGGREGATED_AS.includes(k));
    check(`an array scope keeps every key scope:'${corpus}' carries`, !!sec && missing.length === 0, 'DROPPED: ' + missing.join(', '));
  }
  for (const k of ['indexBuiltAtByScope', 'indexStale', 'staleFiles', 'serverVersion', 'serverStartedAt']) {
    check(`the wrapper carries the top-level ${k}`, (r.topKeys || []).includes(k), JSON.stringify(r.topKeys));
  }
  check('a corpus that matched NOTHING still gets a section, marked empty, still declaring its freshness',
    r.emptySection?.empty === true && typeof r.emptySection?.orderedBy === 'string' && 'indexStale' in (r.emptySection || {}),
    JSON.stringify(r.emptySection && { empty: r.emptySection.empty, orderedBy: r.emptySection.orderedBy }));
  check('...and the corpus that DID match is unaffected', r.stagingAnswered > 0, String(r.stagingAnswered));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('latest with no query is a browse, and `sessions` says what conversations exist');
// `latest` used to answer "no usable terms" — and return BEFORE the freshness check — so the most
// common question ("what have we been working on") had no answer and no staleness warning. And
// nothing could say which CONVERSATIONS exist: search and latest both return exchanges, one moment
// in one chat, never the chat.
{
  const sb = sandbox({ MEMORY_LIBRARY: '0' });
  mkdirSync(sb.env.MEMORY_DIR, { recursive: true });
  writeFileSync(join(sb.env.MEMORY_DIR, 'workshop-rules.md'),
    '---\nname: workshop-rules\ndescription: the standing workshop rules\n---\n\nLight oil on the pawls, never grease.\n');
  const transcripts = join(sb.dir, 'transcripts');
  mkdirSync(transcripts, { recursive: true });
  const env = { ...sb.env, MEMORY_TRANSCRIPT_DIR: transcripts };
  const store = sb.env.MEMORY_OWN_STORE;
  const SA = 'aaaa9090-1111-1111-1111-111111111111';
  const SB = 'bbbb9090-2222-2222-2222-222222222222';
  const exch = (n, sid, ts, title, desc, body, extraMeta = '') =>
    `---\nname: ${n}\ndescription: "${desc}"\nmetadata:\n  type: exchange\n  sessionId: ${sid}\n  sessionTitle: "${title}"\n  ts: ${ts}\n${extraMeta}---\n\n**Asked:** ${desc}\n\n${body}\n`;
  writeFileSync(join(store, 'x-aaaa9090-20260901T010000000Z.md'), exch('x-aaaa9090-20260901T010000000Z', SA, '2026-09-01T01:00:00.000Z',
    'freehub service', 'first A exchange', 'We stripped the freehub and cleaned the pawls thoroughly with solvent and a brush.'));
  writeFileSync(join(store, 'x-aaaa9090-20260901T020000000Z.md'), exch('x-aaaa9090-20260901T020000000Z', SA, '2026-09-01T02:00:00.000Z',
    'freehub service', 'second A exchange, cut off mid-reply', 'The pawl spring measurement was', '  inFlight: true\n'));
  writeFileSync(join(store, 'x-bbbb9090-20260902T010000000Z.md'), exch('x-bbbb9090-20260902T010000000Z', SB, '2026-09-02T01:00:00.000Z',
    'chain wear policy', 'first B exchange', 'Chain wear limits were agreed at 0.75 percent stretch for eleven speed drivetrains.'));
  writeFileSync(join(transcripts, `${SB}.jsonl`), '{"type":"user"}\n');   // B's transcript survives; A's does not
  const CFG = JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'config.js')).href);

  const r = run(env, `
    const { buildIndex } = await import(IDX); const C = await import(${CFG});
    const b = await buildIndex({ force: true, dir: C.rootsForCorpus('staging'), out: C.stagingIndexPath() });
    const memory = await memoryTool();
    const br = await memory({ action: 'latest', scope: 'staging' });
    const br1 = await memory({ action: 'latest', scope: 'staging', limit: 1 });
    const br51 = await memory({ action: 'latest', scope: 'staging', limit: 51 });
    const brSid = await memory({ action: 'latest', scope: 'staging', sessionId: ${JSON.stringify(SA)} });
    const ss = await memory({ action: 'sessions', scope: 'staging' });
    out({ indexed: b.filesIndexed,
          browse: br.browse === true, names: (br.results || []).map((x) => x.name),
          stamped: typeof br.indexBuiltAt === 'string' && 'indexStale' in br && typeof br.orderedBy === 'string',
          noPremise: !('premiseSupported' in br), note: String(br.note || '').slice(0, 40),
          lim1: (br1.results || []).length, refused: /capped at 50/.test(String(br51.error || '')),
          sidRows: (brSid.results || []).length,
          ssMode: ss.mode, ssTotal: ss.total,
          ssRows: (ss.sessions || []).map((x) => [x.sessionId, x.count, x.lastExchange, x.lastInFlight, x.transcriptExists]),
          ssStamped: typeof ss.indexBuiltAt === 'string' && 'indexStale' in ss });`);

  check('the fixture indexed 3 exchanges', r.indexed === 3, JSON.stringify(r.indexed ?? r));
  check('latest with NO query returns the newest rows instead of "no usable terms"',
    r.browse === true && (r.names || []).length === 3 && r.names[0] === 'x-bbbb9090-20260902T010000000Z', JSON.stringify(r.names));
  check('...and the freshness check RAN (the early return used to skip it)', r.stamped === true, JSON.stringify(r));
  check('...and no premise was stated, so premiseSupported is omitted rather than asserted', r.noPremise === true);
  check('...and the note says BROWSE MODE, not an answer', /BROWSE MODE/.test(String(r.note)), String(r.note));
  check('an explicit browse limit is respected; 51 is refused with a clear error',
    r.lim1 === 1 && r.refused === true, JSON.stringify({ lim1: r.lim1, refused: r.refused }));
  check('the sessionId filter still applies with no query terms', r.sidRows === 2, String(r.sidRows));
  check('sessions returns a DIRECTORY of conversations, newest activity first',
    r.ssMode === 'sessions' && r.ssTotal === 2 && r.ssRows?.[0]?.[0] === SB, JSON.stringify(r.ssRows));
  check('...with the exchange count and the name of the last exchange in each',
    r.ssRows?.find((x) => x[0] === SA)?.[1] === 2 && r.ssRows?.find((x) => x[0] === SA)?.[2] === 'x-aaaa9090-20260901T020000000Z',
    JSON.stringify(r.ssRows));
  check('...saying when the last exchange was STILL BEING WRITTEN when captured',
    r.ssRows?.find((x) => x[0] === SA)?.[3] === true && r.ssRows?.find((x) => x[0] === SB)?.[3] === false, JSON.stringify(r.ssRows));
  check('...and whether the transcript that produced it still exists',
    r.ssRows?.find((x) => x[0] === SB)?.[4] === true && r.ssRows?.find((x) => x[0] === SA)?.[4] === false, JSON.stringify(r.ssRows));
  check('...carrying the same freshness stamp every other read carries', r.ssStamped === true, JSON.stringify(r.ssStamped));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('a rewritten store file is ONE document, not two');
// `_staleScan` is [...changed, ...added], so a file the index ALREADY HOLDS is re-read directly
// when it is rewritten — the ordinary case, since the extractor replaces an in-flight exchange the
// moment its reply finishes. Concatenating the index list and the direct list returned that
// exchange twice, unmarked, and counted it twice.
{
  const sb = sandbox();
  const store = sb.env.MEMORY_OWN_STORE;
  const SID = 'cccc7070-3333-3333-3333-333333333333';
  const F1 = 'x-cccc7070-20260906T010000000Z';
  const F2 = 'x-cccc7070-20260906T020000000Z';
  const exch = (n, ts, desc, body) =>
    `---\nname: ${n}\ndescription: "${desc}"\nmetadata:\n  type: exchange\n  sessionId: ${SID}\n  ts: ${ts}\n---\n\n**Asked:** ${desc}\n\n${body}\n`;
  writeFileSync(join(store, `${F1}.md`), exch(F1, '2026-09-06T01:00:00.000Z',
    'the first exchange about pawls', 'We cleaned the freehub pawls and repacked the bearings.'));
  writeFileSync(join(store, `${F2}.md`), exch(F2, '2026-09-06T02:00:00.000Z',
    'the second exchange about pawls', 'The pawl spring measurement came out at the low end.'));

  const readBoth = () => run(sb.env, `
    const memory = await memoryTool();
    const lat = await memory({ action: 'latest', scope: 'staging' });
    const ss  = await memory({ action: 'sessions', scope: 'staging' });
    out({ names: (lat.results || []).map((x) => x.name),
          prov: (lat.results || []).map((x) => x.provenance || null),
          total: lat.totalMentions,
          count: (ss.sessions || [])[0]?.count ?? null, ssTotal: ss.total,
          pending: (ss.sessions || [])[0]?.pendingIndex || false });`);

  const built = run(sb.env, `
    const { buildIndex } = await import(IDX); const C = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'config.js')).href)});
    const b = await buildIndex({ force: true, dir: C.rootsForCorpus('staging'), out: C.stagingIndexPath() });
    out({ filesIndexed: b.filesIndexed });`);
  const clean = readBoth();
  check('the fixture indexed 2 exchanges and reads back as 2', built.filesIndexed === 2 &&
    clean.names?.length === 2 && clean.count === 2 && clean.pending === false, JSON.stringify({ built, clean }));

  // Rewrite a file the index already holds; its mtime must land after the build, and one second is
  // the coarsest mtime granularity this has to survive. A child process rather than a busy-wait,
  // because the public suite runs on windows-latest too.
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1100)'], { encoding: 'utf8', windowsHide: true });
  writeFileSync(join(store, `${F1}.md`), exch(F1, '2026-09-06T01:00:00.000Z',
    'the first exchange about pawls', 'We cleaned the freehub pawls, repacked the bearings and TORQUED THE CASSETTE.'));
  const touched = readBoth();
  const dupes = (touched.names || []).filter((n, i) => (touched.names || []).indexOf(n) !== i);
  check('a rewritten exchange comes back ONCE, not once stale and once current',
    touched.names?.length === 2 && dupes.length === 0, JSON.stringify(touched.names));
  check('...and the copy that survives is the direct read of the file on disk',
    touched.prov?.[(touched.names || []).indexOf(F1)] === 'unindexed-direct', JSON.stringify(touched.prov));
  check('...and sessions does not count it twice',
    touched.count === 2 && touched.ssTotal === 1, JSON.stringify({ count: touched.count, total: touched.ssTotal }));
  check('...while still saying the index has not read it yet', touched.pending === true, JSON.stringify(touched.pending));

  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('a query is a question, not a document');
// `latest` restates the caller's terms four times over — the echoed `query`, `unmatchableTerms`,
// `termWarning`, and the PREMISE line in `guidance`, plus one `termFrequencies` entry per term — so
// its response is a MULTIPLE of the input. Measured before the bound: 1,048,600 bytes in,
// 8,845,421 out. The schema bounds what a client may send; the function bounds what it says back.
{
  const sb = sandbox();
  const store = sb.env.MEMORY_OWN_STORE;
  writeFileSync(join(store, 'x-dddd7070-20260906T010000000Z.md'),
    '---\nname: x-dddd7070-20260906T010000000Z\ndescription: "an exchange about pawls"\nmetadata:\n' +
    '  type: exchange\n  sessionId: dddd7070-4444-4444-4444-444444444444\n  ts: 2026-09-06T01:00:00.000Z\n---\n\n' +
    '**Asked:** an exchange about pawls\n\nWe cleaned the freehub pawls and repacked the bearings.\n');
  run(sb.env, `
    const { buildIndex } = await import(IDX); const C = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'config.js')).href)});
    const b = await buildIndex({ force: true, dir: C.rootsForCorpus('staging'), out: C.stagingIndexPath() });
    out({ filesIndexed: b.filesIndexed });`);
  const bounded = run(sb.env, `
    const z = (await import('zod')).z;
    const m = await import(TOOL);
    let schema = null; m.registerMemoryTools({ tool: (n, dd, s, h) => { if (n === 'memory') schema = s; } });
    const S = z.object(schema);
    const { latest } = await import(SRCH);
    // Exactly the campaign's 1,048,600 bytes, so the before/after numbers are comparable.
    const big = Array.from({ length: 120000 }, (_, i) => 'zqx' + i).join(' ').slice(0, 1048600);
    const res = await latest(big, { scope: 'staging', limit: 5 });
    const normal = await latest('pawls', { scope: 'staging', limit: 5 });
    out({ ok8k: S.safeParse({ action: 'latest', query: 'q'.repeat(8192) }).success,
          bad8k: S.safeParse({ action: 'latest', query: 'q'.repeat(8193) }).success,
          inBytes: big.length, outBytes: JSON.stringify(res).length,
          echo: (res.query || '').length, queryChars: res.queryChars || null,
          termsUsed: res.termsUsed || null, freqKeys: Object.keys(res.termFrequencies || {}).length,
          normalQuery: normal.query, normalClean: !('queryChars' in normal) && !('termsIgnored' in normal) });`);
  check('the schema accepts an 8 KB query and refuses one character more',
    bounded.ok8k === true && bounded.bad8k === false, JSON.stringify(bounded).slice(0, 200));
  check('a 1 MB query answered directly does not amplify into a megabyte response',
    bounded.inBytes > 900000 && bounded.outBytes < 262144,
    JSON.stringify({ inBytes: bounded.inBytes, outBytes: bounded.outBytes }));
  check('...the echo is capped at 512 characters with the real length beside it',
    bounded.echo === 512 && bounded.queryChars === bounded.inBytes, JSON.stringify(bounded));
  check('...and the per-term fields are capped with it',
    bounded.termsUsed === 200 && bounded.freqKeys <= 200, JSON.stringify({ used: bounded.termsUsed, freq: bounded.freqKeys }));
  check('CONTROL — an ordinary query is echoed whole and carries none of the new fields',
    bounded.normalQuery === 'pawls' && bounded.normalClean === true, JSON.stringify(bounded.normalQuery));
  cleanupSandbox(sb.dir);
}

// =============================================================================================
group('MEM-69 — no public test may clean up the way the one that died on Windows did');
// A Windows PC running the shipped 1.7.1 suite lost 32 checks because ONE file
// (fresh-install-e2e.mjs) called `child.kill()` and then `rmSync` on the sandbox a line later:
// the kill did not reach the scheduler's capture grandchildren, it did not wait, and Windows
// cannot unlink an open file. 130/130 checks had passed; the runner still exited 1.
//
// The repair is a shared helper (sandbox-cleanup.mjs). The DEFECT, though, was not the missing
// retry — it was that three sibling files already did this correctly and nobody noticed the
// fourth did not. A convention that only a reviewer enforces is the convention that gets missed,
// so the convention is asserted here, structurally, over the files themselves.
{
  // A pure function over SOURCE TEXT, so the same detector can be pointed at a planted bad file
  // below. A structural rule nobody has watched fail is a rule that might match nothing at all.
  const inspect = (src) => {
    // Strip comment lines so the prose ABOVE a fix cannot satisfy or trip the check.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    return {
      // execFileSync/execSync spawn a process too. They were missing here until cli-flags.mjs
      // — six subprocesses — slipped past the rule entirely and only the CONTROL below caught
      // it, by counting one fewer file than the directory holds. That is what the control is
      // for; the detector it guards is now as wide as the thing it claims to detect.
      spawnsOrSandboxes: /\bspawn\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(|\bexecSync\s*\(|\bexecFile\s*\(|\bmkdtempSync\s*\(/.test(code),
      imports:  /from '\.\/sandbox-cleanup\.mjs'/.test(code),
      // The two shapes MEM-69 was made of, named separately so a failure says which one.
      bareKill: /(?<!stop)(?<!\w)child\.kill\s*\(|\bsrv\.kill\s*\(/.test(code),
      bareRm:   /rmSync\s*\(\s*(dir|D|sb\.dir|sb2\.dir)\b/.test(code)
    };
  };

  const dir = join(HERE);
  const SELF = new Set(['kill-tree.mjs', 'sandbox-cleanup.mjs']);
  const files = readdirSync(dir).filter((f) => (f.endsWith('.mjs') || f.endsWith('.js')) && !SELF.has(f));
  const offenders = [], bareKill = [], bareRm = [];
  let considered = 0;
  for (const f of files) {
    const v = inspect(readFileSync(join(dir, f), 'utf8'));
    if (!v.spawnsOrSandboxes) continue;
    considered++;
    if (!v.imports) offenders.push(f);
    if (v.bareKill) bareKill.push(f);
    if (v.bareRm) bareRm.push(f);
  }
  check('every public test that spawns a process or makes a sandbox imports sandbox-cleanup.mjs',
    offenders.length === 0, offenders.join(', '));
  check('...and none of them still stops a child with a bare kill()',
    bareKill.length === 0, bareKill.join(', '));
  check('...and none of them still removes its sandbox with a bare rmSync',
    bareRm.length === 0, bareRm.join(', '));
  check('CONTROL — the check is not vacuous: it examined every spawning file in the directory',
    considered >= 6 && considered === files.length,
    `${considered} of ${files.length} public test file(s) spawn or sandbox`);

  // NEGATIVE CONTROL — the code as it stood on the Windows PC. All three rules must fire on it,
  // or the three PASSes above mean nothing.
  {
    // 🟥 ASSEMBLED FROM PIECES, not written out. Spelling the offending lines literally here would
    // make THIS file trip its own rule — which it promptly did the first time, and is a fair
    // reminder that a structural check reads the checker too.
    const K = 'child' + '.kill()';
    const R = 'rmSync' + '(dir, { recursive: true, force: true })';
    const asItWas = [
      "import { spawn } from 'node:child_process';",
      "const dir = mkdtempSync(join(tmpdir(), 'fresh-e2e-'));",
      "const child = spawn(process.execPath, [join(TREE, 'index.js')], {});",
      `try { ${K}; } catch { }`,
      `${R};`
    ].join('\n');
    const v = inspect(asItWas);
    check('NEGATIVE CONTROL — the pre-fix fresh-install-e2e.mjs trips all three rules',
      v.spawnsOrSandboxes && !v.imports && v.bareKill && v.bareRm, JSON.stringify(v));
  }

  // ---- the other half of MEM-69: the kill is ASYNCHRONOUS ----------------------------------
  // `child.kill()` posts the request and returns; the failing line ran while the server was still
  // shutting down. stopChild resolves only once the process has actually exited, and it kills the
  // TREE — the grandchildren (walker → auto-ingest → extractor) are what held the sandbox open.
  {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'],
      { stdio: 'ignore', windowsHide: true, ...spawnOptsForKill() });
    const alive = sleeper.exitCode === null;
    const st = await stopChild(sleeper, { timeoutMs: 8000 });
    check('stopChild kills the tree and RESOLVES ONLY AFTER the child has really exited',
      alive && st.exited === true && (sleeper.exitCode !== null || sleeper.signalCode !== null),
      JSON.stringify({ ...st, exitCode: sleeper.exitCode, signal: sleeper.signalCode }));
    const already = await stopChild(sleeper, { timeoutMs: 1000 });
    check('CONTROL — stopping an already-dead child returns at once and reports it',
      already.exited === true && already.how === 'already gone', JSON.stringify(already));
  }

  // ---- the Windows shape, twice: once for real, once fed in --------------------------------
  // FIRST, the control that says why the second one is necessary. Hold an OPEN FILE HANDLE inside
  // the sandbox and remove it anyway: on POSIX this SUCCEEDS (unlink drops the directory entry;
  // the inode lives until the last fd closes), which is exactly why MEM-69 was invisible on the
  // Mac for as long as it existed. On Windows the same handle is what makes rmdir EBUSY. So this
  // check asserts the platform difference rather than pretending to reproduce the failure.
  {
    const held = mkdtempSync(join(tmpdir(), 'mem69-held-'));
    const f = join(held, 'open.txt');
    writeFileSync(f, 'held open across the removal');
    const fd = openSync(f, 'r');
    const out = cleanupSandbox(held, { label: 'mem69-open-fd', attempts: 2, delayMs: 5 });
    try { closeSync(fd); } catch { /* already gone on POSIX */ }
    const posix = process.platform !== 'win32';
    // 🟥 WINDOWS ASSERTS THE HONEST REPORT, NOT A REMOVAL. The handle is held open across the WHOLE
    // call, and on Windows that is precisely what makes rmdir fail -- no number of retries helps
    // while the holder never lets go, because retries exist for a holder that is ABOUT to release.
    // This passed on node 22 only because newer node opens files with FILE_SHARE_DELETE, so the
    // unlink succeeds POSIX-style; node 20 does not, and CI went red on windows/20 alone -- caught
    // by the first public run, 2026-09-08. Asserting the removal there was asserting a node
    // version, not a contract.
    //
    // What must hold on every platform and every version: the cleanup does not throw, and what it
    // REPORTS matches the filesystem. A cleanup claiming it removed a directory that is still there
    // is the defect worth catching, and this catches it in both directions.
    check(posix
      ? 'CONTROL — an open fd does NOT block the removal on POSIX (which is why MEM-69 hid on the Mac)'
      : 'on Windows an open fd may block the removal, and the report matches the filesystem',
      posix ? (out.removed === true && !existsSync(held))
            : (typeof out.removed === 'boolean' && out.removed === !existsSync(held)),
      JSON.stringify({ ...out, stillThere: existsSync(held), platform: process.platform }));
    cleanupSandbox(held);
  }

  // SECOND, the real proof on this machine: make the remove FAIL the way Windows makes it fail.
  const victim = mkdtempSync(join(tmpdir(), 'mem69-'));
  writeFileSync(join(victim, 'held.txt'), 'a file Windows would call busy');
  let calls = 0;
  const ebusyOnce = (p, o) => {
    calls++;
    if (calls === 1) { const e = new Error(`EBUSY: resource busy or locked, rmdir '${p}'`); e.code = 'EBUSY'; throw e; }
    rmSyncReal(p, o);
  };
  const r = cleanupSandbox(victim, { label: 'mem69-probe', rm: ebusyOnce, delayMs: 10 });
  check('an EBUSY on the first attempt is retried, and the second attempt removes the tree',
    r.removed === true && r.attempts === 2 && !existsSync(victim),
    JSON.stringify({ ...r, calls, stillThere: existsSync(victim) }));

  // NEGATIVE CONTROL — a remove that never succeeds must WARN and return, never throw.
  const doomed = mkdtempSync(join(tmpdir(), 'mem69-doomed-'));
  const alwaysBusy = (p) => { const e = new Error(`EBUSY: resource busy or locked, rmdir '${p}'`); e.code = 'EBUSY'; throw e; };
  const logged = [];
  let threw = null;
  try {
    var stuck = cleanupSandbox(doomed, { label: 'mem69-doomed', rm: alwaysBusy, attempts: 3, delayMs: 5,
      log: (m) => logged.push(m) });
  } catch (e) { threw = e; }
  check('a cleanup that CANNOT succeed warns and lets the run continue — it never throws',
    threw === null && stuck && stuck.removed === false && logged.length === 1 &&
      /^\s*warn\s+cleanup:/.test(logged[0]) && logged[0].includes('EBUSY'),
    JSON.stringify({ threw: threw && threw.code, stuck, log: logged[0] }));
  check('...and this whole group ran AFTER that failure, which is the property MEM-69 broke',
    true, 'the runner is still alive');
  rmSyncReal(doomed, { recursive: true, force: true });
}

// =============================================================================================
group("(a98) the scope:'all' envelope — an empty corpus, one copy of the rows, and brief");
// MEM-85 and MEM-86, both reported live on 2026-09-07 out of ONE scope:'all' response: 56,550
// bytes for ten results, whose top level said `indexStale: true`, `staleFiles: 0` and "There is no
// index on disk" because ONE of the four corpora had no folder on that machine — while another had
// just ranked ten hits from an index built seven minutes earlier. The reporting client believed the
// envelope over the results sitting beside it, and the response was too big to read in one piece.
//
// The contracts, over committed fixtures, so they hold on a machine that has never seen a real
// memory (and on windows-latest, where this suite runs):
//   * an EMPTY corpus (0 files, no index) is `empty: true` and contributes nothing to the
//     top-level verdict, and the "no index on disk" sentence never appears up there;
//   * the section that ranked rows serializes them ONCE (`resultsRef` + `count`), and the rows at
//     the top level are those rows, field for field against a named-scope call;
//   * a section that ranked nothing beside one that did keeps names+scores — with the control that
//     when NOTHING hit anywhere, the fallback and its verdict survive in full;
//   * `brief: true` trims ROWS and keeps every honesty field in the envelope.
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const store = sb.env.MEMORY_OWN_STORE;
  const exch = (n, ts, ask, body) => ['---', `name: ${n}`, `description: "${ask}"`, 'metadata:',
    '  type: exchange', '  sessionId: eeee9898-0000-0000-0000-000000000000', `  ts: ${ts}`,
    '---', '', `**Asked:** ${ask}`, '', body, ''].join('\n');
  writeFileSync(join(store, 'x-eeee9898-20260905T010000000Z.md'),
    exch('x-eeee9898-20260905T010000000Z', '2026-09-05T01:00:00.000Z',
      'why did we stop stocking the small sealant bottles',
      'We stopped because it dried out before we could use it. The large bottle is the only size we buy now.'));
  // ONE SCOPE HITS AND ANOTHER FALLS BACK — the payload's shape, and the only shape in which the
  // bestWeak cap fires. `chainwaxer` appears nowhere in the 16 gold memories (it is that corpus's
  // own absence control), so this query ranks in staging and is REFUSED in curated.
  writeFileSync(join(store, 'x-eeee9898-20260904T090000000Z.md'),
    exch('x-eeee9898-20260904T090000000Z', '2026-09-04T09:00:00.000Z',
      'what temperature does the chainwaxer bath run at',
      'The chainwaxer bath sits at 90 degrees and the chain hangs for twenty minutes. Nobody outside the workshop touches the chainwaxer.'));

  const Q = 'chainwaxer bath temperature';
  const r = run(sb.env, `
    // Built through the REAL roots, not buildIndexOver's one-root shorthand: rootsForCorpus gives
    // the store root its production label, and a file indexed under a different label reads as
    // "added" to checkStaleness — which would make staging honestly stale here and the MEM-85
    // assertion below measure the fixture instead of the code.
    const { buildIndex } = await import(IDX);
    const CFG = new URL('config.js', IDX).href;
    const cfg = await import(CFG);
    await buildIndex({ force: true, dir: cfg.rootsForCorpus('curated'), out: cfg.indexPath() });
    await buildIndex({ force: true, dir: cfg.rootsForCorpus('staging'), out: cfg.stagingIndexPath() });
    const m = await import(TOOL); const c = new Map();
    m.registerMemoryTools({ tool: (n, d, s, h) => c.set(n, h) });
    const W2 = new Set(['import', 'capture', 'index', 'demote', 'promote']);   // 2.0.0: route by action
    const call = async (args) => { const x = await c.get(W2.has(args.action) ? 'memory_write' : 'memory')(args); return { text: x.content[0].text, body: JSON.parse(x.content[0].text) }; };
    const all   = await call({ action: 'search', query: ${JSON.stringify(Q)}, scope: 'all', limit: 5 });
    const g = all.body.groups || {};
    const refScope = Object.entries(g).find(([, x]) => x.resultsRef === 'results')?.[0] || null;
    const named = await call({ action: 'search', query: ${JSON.stringify(Q)}, scope: refScope || 'staging', limit: 5 });
    const brief = await call({ action: 'search', query: ${JSON.stringify(Q)}, scope: 'all', limit: 5, brief: true });
    const nowhere = await call({ action: 'search', query: 'zzq airport parking permit renewal for staff cars', scope: 'all', limit: 5 });
    const refRows = (all.body.results || []).filter((x) => x.corpus === refScope);
    const weak = Object.entries(g).filter(([, x]) => (x.bestWeak || []).length && !x.resultsRef);
    const nowhereWeak = Object.entries(nowhere.body.groups || {}).filter(([, x]) => (x.bestWeak || []).length);
    const briefRowKeys = [...new Set([...(brief.body.results || []),
      ...Object.values(brief.body.groups || {}).flatMap((x) => x.bestWeak || [])].flatMap((x) => Object.keys(x)))].sort();
    const SAID_ONCE = ['query', 'serverVersion', 'serverStartedAt', 'modifiedFieldNote', 'indexPath',
      'indexCheckMs', 'indexCheckedFiles', 'newestSourceModified', 'staleNewestModified', 'staleFilesRemoved'];
    const bytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null));
    out({
      // MEM-85
      topStale: all.body.indexStale, topStaleFiles: all.body.staleFiles,
      topWarn: all.body.staleWarning === undefined ? null : String(all.body.staleWarning),
      emptyScopes: Object.entries(g).filter(([, x]) => x.empty === true).map(([k]) => k),
      emptyNoteSaysFiles: Object.values(g).filter((x) => x.empty).every((x) => /0 corpus files/.test(String(x.emptyNote || ''))),
      noIndexSentenceAtTop: /no index on disk/i.test(JSON.stringify({ ...all.body, groups: undefined })),
      // MEM-86 (a)
      refScope,
      refCount: refScope ? g[refScope].count : null,
      sectionsStillHoldingRows: Object.entries(g).filter(([, x]) => (x.results || []).length).map(([k]) => k),
      refMatchesNamed: JSON.stringify(refRows) === JSON.stringify(named.body.results || []),
      refRowCount: refRows.length,
      saysWhereRowsAre: /resultsRef/.test(String(all.body.resultsNote || '')),
      // MEM-86 (b)
      weakScopes: weak.map(([k]) => k),
      weakKeysOnly: weak.length > 0 && weak.every(([, x]) => x.bestWeak.length <= 3 &&
        x.bestWeak.every((y) => Object.keys(y).sort().join(',') === 'name,score')),
      weakAbsenceDropped: weak.every(([, x]) => x.absenceNote === undefined),
      weakVerdictKept: weak.every(([, x]) => x.noStrongMatch === true && !!x.signals),
      saysTrimmed: (all.body.guidance || []).some((l) => /NEAREST NEIGHBOURS TRIMMED/.test(l)),
      // MEM-86 (b) control
      nowhereWeakFull: nowhereWeak.length > 0 && nowhereWeak.some(([, x]) => (x.bestWeak[0] || {}).snippet),
      nowhereKeepsAbsence: nowhereWeak.some(([, x]) => typeof x.absenceNote === 'string' && x.absenceNote.length > 80),
      nowhereSaysTrimmed: (nowhere.body.guidance || []).some((l) => /NEAREST NEIGHBOURS TRIMMED/.test(l)),
      // MEM-86 (d)
      saidOnceLeftInSections: Object.entries(g).map(([k, x]) => [k, SAID_ONCE.filter((y) => y in x)]).filter(([, v]) => v.length),
      modifiedNoteAtTop: /mtime AT INDEX TIME/.test(String(all.body.modifiedFieldNote || '')),
      namedKeepsThem: SAID_ONCE.filter((k) => k in named.body).length,
      // MEM-86 (c)
      briefRowKeys,
      briefKeepsStamps: ['indexStale', 'staleFiles', 'indexBuiltAtByScope', 'serverVersion', 'modifiedFieldNote'].every((k) => k in brief.body),
      briefNoteOnce: typeof brief.body.briefNote === 'string' &&
        Object.values(brief.body.groups || {}).every((x) => x.briefNote === undefined),
      fullRowKeyCount: new Set((all.body.results || []).flatMap((x) => Object.keys(x))).size,
      fullRowBytes: bytes(all.body.results), briefRowBytes: bytes(brief.body.results),
      bytesAll: Buffer.byteLength(all.text), bytesBrief: Buffer.byteLength(brief.text)
    });`);

  check('MEM-86: the fixture has ONE scope ranking and one falling back (or half these checks are vacuous)',
    r.refScope !== null && Array.isArray(r.weakScopes) && r.weakScopes.length > 0,
    JSON.stringify({ ref: r.refScope, weak: r.weakScopes, err: r.stderr, status: r.status }));
  check('MEM-85: an EMPTY corpus does not make the whole response stale',
    r.topStale === false && Number(r.topStaleFiles) === 0 && r.topWarn === null,
    JSON.stringify({ stale: r.topStale, files: r.topStaleFiles, warn: String(r.topWarn || '').slice(0, 120) }));
  check('MEM-85: ...the empty corpora are named as empty, in their own sections, with one line saying why',
    Array.isArray(r.emptyScopes) && r.emptyScopes.length >= 2 && r.emptyNoteSaysFiles === true,
    JSON.stringify({ empty: r.emptyScopes, noteOk: r.emptyNoteSaysFiles }));
  check('MEM-85: ...and the "no index on disk" sentence appears nowhere at the top level',
    r.noIndexSentenceAtTop === false, JSON.stringify(r.noIndexSentenceAtTop));
  check('MEM-86(a): the section that ranked rows delegates to the single top-level copy',
    r.refCount > 0 && Array.isArray(r.sectionsStillHoldingRows) && r.sectionsStillHoldingRows.length === 0 &&
    r.saysWhereRowsAre === true,
    JSON.stringify({ scope: r.refScope, count: r.refCount, dupes: r.sectionsStillHoldingRows, said: r.saysWhereRowsAre }));
  check('MEM-86(a): ...and that copy is the SAME rows a named scope returns, field for field',
    r.refMatchesNamed === true && r.refRowCount > 0,
    JSON.stringify({ match: r.refMatchesNamed, rows: r.refRowCount }));
  check('MEM-86(b): a section that ranked nothing, beside one that did, keeps names+scores and drops the absence paragraph',
    r.weakKeysOnly === true && r.weakAbsenceDropped === true && r.saysTrimmed === true,
    JSON.stringify({ scopes: r.weakScopes, keysOnly: r.weakKeysOnly, dropped: r.weakAbsenceDropped, said: r.saysTrimmed }));
  check('MEM-86(b): ...while the VERDICT itself stays — noStrongMatch and the score signals',
    r.weakVerdictKept === true, JSON.stringify(r.weakVerdictKept));
  check('MEM-86(b) [control]: when NOTHING hit anywhere, bestWeak and the absence verdict stay in full',
    r.nowhereWeakFull === true && r.nowhereKeepsAbsence === true && r.nowhereSaysTrimmed === false,
    JSON.stringify({ full: r.nowhereWeakFull, absence: r.nowhereKeepsAbsence, said: r.nowhereSaysTrimmed }));
  check('MEM-86(d): nothing identical across sections, and no per-corpus diagnostic, is repeated in them',
    Array.isArray(r.saidOnceLeftInSections) && r.saidOnceLeftInSections.length === 0 && r.modifiedNoteAtTop === true,
    JSON.stringify({ left: r.saidOnceLeftInSections, atTop: r.modifiedNoteAtTop }));
  check('MEM-86(d) [control]: a NAMED scope still carries them — this is a grouped-view saving, not a removal',
    Number(r.namedKeepsThem) >= 6, `${r.namedKeepsThem} of 10 present on the named-scope response`);
  check('MEM-86(c): brief:true trims the ROWS to identity, score, snippet, provenance and a timestamp',
    Array.isArray(r.briefRowKeys) && r.briefRowKeys.length > 0 &&
    r.briefRowKeys.every((k) => ['name', 'corpus', 'score', 'snippet', 'provenance', 'ts', 'modified'].includes(k)),
    JSON.stringify(r.briefRowKeys));
  check('MEM-86(c): ...and keeps every envelope stamp, saying so once',
    r.briefKeepsStamps === true && r.briefNoteOnce === true,
    JSON.stringify({ stamps: r.briefKeepsStamps, once: r.briefNoteOnce }));
  check('MEM-86(c) [control]: without brief the rows still carry their diagnostic fields',
    Number(r.fullRowKeyCount) > 7, `${r.fullRowKeyCount} distinct row keys`);
  check(`MEM-86(c): brief more than halves the rows (${r.briefRowBytes} vs ${r.fullRowBytes} B)`,
    Number(r.briefRowBytes) > 0 && Number(r.briefRowBytes) < Number(r.fullRowBytes) * 0.5,
    `${r.briefRowBytes} / ${r.fullRowBytes}`);
  check(`MEM-86: ...and the whole response with it (${r.bytesBrief} vs ${r.bytesAll} B of tool text)`,
    Number(r.bytesBrief) > 0 && Number(r.bytesBrief) < Number(r.bytesAll),
    `${r.bytesBrief} / ${r.bytesAll}`);
  cleanupSandbox(sb.dir);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail ? 1 : 0);
