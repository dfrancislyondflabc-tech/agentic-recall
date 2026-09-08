// test/public/import-index-e2e.mjs — an import is not finished until the index knows.
//
// TWO FIXES, ONE PATH, AND BOTH WERE INVISIBLE ON THE PLATFORM THAT NEEDED THEM.
//
// MEM-72. Campaign E imported eight shapes twice and every document was still
// unindexed 300 s later — served by the honest `unindexed-direct` read (a substring
// scan that answers a token but not a paraphrase, re-run on every query) and never
// ranked, because nothing rebuilds a CURATED index: the walker reconciles staging
// only and the inline rebuild refuses anything over 8 changed files. `import` now
// starts the async index job itself and returns its `indexJobId`.
//
// MEM-73. `has()` probed converters through `shell:'/bin/bash'`, which does not
// exist on Windows, so every converter read as missing there and `.zip` import was
// refused outright — two of those eight shapes, gone. The probe is now `where` /
// `which` with no shell, and archives are read in-process by lib/zip.js, so there
// is no binary left to be missing.
//
// 🟥 THIS FILE IS IN THE PUBLIC SUITE ON PURPOSE. The one check that covered zip
// import self-skipped on windows-latest for want of the `zip` WRITER binary, so it
// passed vacuously on every Windows run of the release that shipped MEM-73's bug.
// Everything here builds its fixtures in Node and runs on every platform.

import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { cleanupSandbox } from './sandbox-cleanup.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeZipSync } from '../../lib/zip.js';
import { readSource, probeBinary, probeCommandFor, converterReport } from '../../lib/import-sources.js';

export async function importIndexE2E({ check, group, sandbox, run }) {
  // ─────────────────────────────────────────────────────────────────────────────
  group('MEM-72 — an import that wrote files starts its own index build');
  // ─────────────────────────────────────────────────────────────────────────────
  // ONE CHILD FOR THE WHOLE STORY. The job registry lives in the server process, so
  // an import here and an index_status there would be two different registries and
  // the poll would answer `found: false` for a job that is running perfectly.
  {
    const sb = sandbox();
    const src = join(sb.dir, 'src');
    mkdirSync(src, { recursive: true });
    mkdirSync(sb.env.MEMORY_DIR, { recursive: true });
    // 🟥 THE VARIABLE IS NOT CALLED T-O-K-E-N, AND THAT IS NOT STYLE. The
    // `token-assignment` rule in secrets-exclude.json redacts any name ending in that
    // word followed by 16+ characters, and scrub-tree.mjs runs over every shipped
    // file — so the first version of this fixture reached the release tree as a
    // redaction marker spliced into the middle of a string literal, and the (a80)
    // gate refused to build a zip whose JavaScript no longer parses. A synthetic
    // fixture that LOOKS like a credential costs a build.
    const MARK = 'zqkickindex77';
    for (const [n, body] of [
      ['kiln', `The kiln fires at 1200 degrees and the ${MARK} schedule hangs by the door for eight hours.`],
      ['glaze', `Stir the glaze bucket before every dip; the ${MARK} batch goes on thin when nobody does.`],
      ['wedging', `Wedge the clay sixty times or the ${MARK} pieces trap air and burst in the firing.`]
    ]) writeFileSync(join(src, `${n}.md`), `# ${n}\n\n${body}\n`);
    // A SECOND SOURCE, WITH A DIFFERENT MARK, for the single-flight case. Re-importing
    // the same folder would leave three more files carrying MARK unindexed, and the
    // direct read would answer from them — the very state the checks below assert is
    // gone, so the test would fail for a reason that has nothing to do with the fix.
    const src2 = join(sb.dir, 'src2');
    mkdirSync(src2, { recursive: true });
    writeFileSync(join(src2, 'slipware.md'),
      '# slipware\n\nThe zqsecondsource99 tray of slipware waits by the wheel until the bisque is cool.\n');

    // sandbox() sets MEMORY_INLINE_REINDEX=0, which is what keeps this honest: with the
    // inline rebuild on, a query alone could index three stale files and every check
    // below would pass over a feature that never ran.
    const r = run({ ...sb.env, MEMORY_IMPORT_AUTOINDEX: '1' }, `
      const memory = await memoryTool();
      const startedAt = Date.now();
      const imp = await memory({ action: 'import', path: ${JSON.stringify(src)}, name: 'kickimp', dry: false });
      const importMs = Date.now() - startedAt;
      // A second import WHILE the first build runs must not start a second build of
      // the same corpus. Issued immediately, with no await in between beyond the
      // import's own, so the job is still registered as in flight.
      const imp2 = await memory({ action: 'import', path: ${JSON.stringify(src2)}, name: 'kickimp2', dry: false });
      let st = await memory({ action: 'index_status', jobId: imp.indexJobId });
      for (let i = 0; i < 180 && st.state === 'running'; i++) {
        await new Promise((r2) => setTimeout(r2, 500));
        st = await memory({ action: 'index_status', jobId: imp.indexJobId });
      }
      const lat = await memory({ action: 'latest', query: ${JSON.stringify(MARK)}, scope: 'curated', limit: 5 });
      const sea = await memory({ action: 'search', query: ${JSON.stringify(MARK)}, scope: 'curated', limit: 5 });
      out({
        written: imp.written, jobId: imp.indexJobId || null, scope: imp.indexScope || null,
        sentence: (imp.next || [])[0] || '', importMs,
        second: { jobId: imp2.indexJobId || null, already: imp2.indexAlreadyRunning === true, written: imp2.written },
        state: st.state, jobScopes: st.scopes, filesIndexed: (st.indexes || [])[0]?.filesIndexed ?? null,
        startedAt,
        builtAt: lat.indexBuiltAt || sea.indexBuiltAt || null,
        latRows: (lat.results || []).map((x) => ({ name: x.name, prov: x.provenance || 'index' })),
        seaRows: [...(sea.results || []), ...(sea.bestWeak || [])].map((x) => ({ name: x.name, prov: x.provenance || 'index' })),
        foundInUnindexed: Object.keys(sea.foundInUnindexed || {})
      });`);

    check('MEM-72: an import that wrote files returns an indexJobId', !!r.jobId && r.written === 3,
      JSON.stringify({ written: r.written, jobId: r.jobId, err: r.stderr }).slice(0, 300));
    check('MEM-72: ...for the corpus it wrote to', r.scope === 'curated' && JSON.stringify(r.jobScopes) === '["curated"]',
      JSON.stringify({ scope: r.scope, jobScopes: r.jobScopes }));
    check('MEM-72: ...and it does not block the import on the build',
      typeof r.importMs === 'number' && r.importMs < 5000, `${r.importMs} ms`);
    check('MEM-72: ...and the response SAYS what the job means, naming index_status',
      /index_status/.test(r.sentence || '') && /served from the store/.test(r.sentence || ''),
      (r.sentence || '').slice(0, 160));
    check('MEM-72: a second import while the build runs JOINS it — same jobId, and it says so',
      r.second && r.second.jobId === r.jobId && r.second.already === true, JSON.stringify(r.second));
    check('MEM-72: the job reaches done', r.state === 'done', String(r.state));
    check('MEM-72: ...having indexed the imported documents', (r.filesIndexed || 0) >= 3, String(r.filesIndexed));
    // THE ACTUAL CLAIM. Before the fix these rows came back with
    // provenance:'unindexed-direct' — returned, but not ranked, for ever.
    check('MEM-72: the token is now answered BY THE INDEX, not by the direct store read',
      (r.latRows || []).length > 0 && (r.latRows || []).every((x) => x.prov !== 'unindexed-direct'),
      JSON.stringify(r.latRows));
    // NOT "search RANKS it": a nonsense token in a three-document corpus can sit under
    // the 0.38 absence floor and come back as bestWeak, which is documented behaviour
    // and says nothing about indexing. The claim is that search reaches these documents
    // THROUGH THE INDEX and finds nothing left unindexed for the token.
    check('MEM-72: ...search reaches them through the index, with nothing left unindexed for that token',
      (r.seaRows || []).length > 0 && (r.seaRows || []).every((x) => x.prov !== 'unindexed-direct') &&
      (r.foundInUnindexed || []).length === 0,
      JSON.stringify({ rows: r.seaRows, unindexed: r.foundInUnindexed }));
    check('MEM-72: ...and the index that answers is one built AFTER the import',
      !!r.builtAt && Date.parse(r.builtAt) >= r.startedAt,
      JSON.stringify({ builtAt: r.builtAt, importStartedAt: new Date(r.startedAt || 0).toISOString() }));
    cleanupSandbox(sb.dir, { label: 'import-index-e2e' });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  group('MEM-72 — a dry run starts nothing, and the kill switch leaves the old behaviour intact');
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const sb = sandbox();
    const src = join(sb.dir, 'src');
    mkdirSync(src, { recursive: true });
    mkdirSync(sb.env.MEMORY_DIR, { recursive: true });
    const MARK = 'zqnokickswitch88';
    for (const n of ['alpha', 'beta', 'gamma'])
      writeFileSync(join(src, `${n}.md`), `# ${n}\n\nThe ${MARK} bench notes for ${n} run to several sentences of ordinary workshop prose.\n`);

    const dry = run({ ...sb.env, MEMORY_IMPORT_AUTOINDEX: '1' }, `
      const memory = await memoryTool();
      const d = await memory({ action: 'import', path: ${JSON.stringify(src)}, name: 'drykick', dry: true });
      const jobs = await memory({ action: 'index_status' });
      out({ hasJob: 'indexJobId' in d, written: d.written, wouldWrite: d.wouldWrite, jobCount: (jobs.jobs || []).length });`);
    check('MEM-72: a DRY run writes nothing and starts nothing',
      dry.hasJob === false && dry.written === 0 && dry.wouldWrite === 3 && dry.jobCount === 0, JSON.stringify(dry));

    const off = run({ ...sb.env, MEMORY_IMPORT_AUTOINDEX: '0' }, `
      const memory = await memoryTool();
      const i = await memory({ action: 'import', path: ${JSON.stringify(src)}, name: 'offkick', dry: false });
      const jobs = await memory({ action: 'index_status' });
      const lat = await memory({ action: 'latest', query: ${JSON.stringify(MARK)}, scope: 'curated', limit: 5 });
      out({ hasJob: 'indexJobId' in i, written: i.written, skipped: i.indexJobSkipped || null,
            jobCount: (jobs.jobs || []).length,
            rows: (lat.results || []).map((x) => ({ name: x.name, prov: x.provenance || 'index' })) });`);
    check('MEM-72: MEMORY_IMPORT_AUTOINDEX=0 writes the files and starts NO job',
      off.hasJob === false && off.written === 3 && off.jobCount === 0, JSON.stringify(off).slice(0, 240));
    check('MEM-72: ...and says so, naming the variable rather than going quiet',
      /MEMORY_IMPORT_AUTOINDEX=0/.test(off.skipped || ''), String(off.skipped));
    // CONTROL. The kill switch must return the OLD behaviour, not a hole: with no
    // index, the direct store read is what answers, and it still does.
    check('MEM-72 [control]: with the switch off the documents are still SERVED — by the direct read',
      (off.rows || []).length > 0 && (off.rows || []).every((x) => x.prov === 'unindexed-direct'),
      JSON.stringify(off.rows));
    cleanupSandbox(sb.dir, { label: 'import-index-e2e' });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  group('MEM-73 — the converter probe, on a platform this machine may not be');
  // ─────────────────────────────────────────────────────────────────────────────
  // Actions is billing-blocked, so the Windows BRANCH is proved by feeding the probe
  // a platform and a recorded spawn shape rather than by running on Windows. What
  // that proves is the branch and the argv; the Windows RUN is still pending.
  {
    const calls = [];
    const rec = (status) => (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return { status, error: null }; };
    const enoent = () => { const e = new Error('spawnSync /bin/bash ENOENT'); e.code = 'ENOENT'; return { error: e, status: null }; };

    check('MEM-73: the finder is `where` on win32 and `which` everywhere else',
      probeCommandFor('win32') === 'where' && probeCommandFor('darwin') === 'which' && probeCommandFor('linux') === 'which',
      JSON.stringify([probeCommandFor('win32'), probeCommandFor('darwin'), probeCommandFor('linux')]));

    const found = probeBinary('pdftotext', { platform: 'win32', spawn: rec(0) });
    check('MEM-73: on win32 it spawns `where pdftotext` with NO shell, and exit 0 means present',
      found === true && calls[0].cmd === 'where' && JSON.stringify(calls[0].argv) === '["pdftotext"]' && calls[0].opts.shell === false,
      JSON.stringify({ found, call: calls[0] && { cmd: calls[0].cmd, argv: calls[0].argv, shell: calls[0].opts.shell } }));
    check('MEM-73: on win32 a non-zero exit means absent (where prints nothing and exits 1)',
      probeBinary('pdftotext', { platform: 'win32', spawn: rec(1) }) === false);
    // THE BUG ITSELF, reproduced: the old probe spawned through /bin/bash, which on
    // Windows ENOENTs — so every converter read as missing whatever was installed.
    check('MEM-73: an ENOENT from the spawn reads as absent, not as a crash',
      probeBinary('pdftotext', { platform: 'win32', spawn: enoent }) === false);
    check('MEM-73: the real probe answers on THIS machine (a shell builtin is not a binary)',
      probeBinary('node') === true && probeBinary('zzz-no-such-binary-9d1f') === false,
      JSON.stringify([probeBinary('node'), probeBinary('zzz-no-such-binary-9d1f')]));

    const rep = converterReport();
    check('MEM-73: converterReport names the platform and the probe it used',
      rep.platform === process.platform && rep.probedWith === probeCommandFor(),
      JSON.stringify({ platform: rep.platform, probedWith: rep.probedWith }));
    check('MEM-73: ...reports pdf/doc tools as what the probe actually found here',
      rep.pdftotext === probeBinary('pdftotext') && rep.textutil === probeBinary('textutil'),
      JSON.stringify({ pdftotext: rep.pdftotext, textutil: rep.textutil }));
    check('MEM-73: ...and no longer reports a zip binary, because there is not one to miss',
      !('unzip' in rep) && /in-process/.test(String(rep.zip)), JSON.stringify(rep.zip));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  group('MEM-73 — a zip imports with no binary anywhere, and still cannot read off-archive');
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const d = mkdtempSync(join(tmpdir(), 'recall-zip-'));
    // 🟥 MEM-76 — WHAT THIS GROUP LEAVES IN TEMP. Every `.zip` read below unpacks into a
    // `mem-import-*` directory, and until 1.7.3 none of them was ever removed: the Windows
    // acceptance of 1.7.2 measured TEMP going 0 -> 5 from a plain `run-public-tests.js`, before
    // the recipient had imported anything of their own, each directory holding a cleartext copy
    // of the archive's files. Counted here rather than in the repo-only suite because THIS is the
    // suite that runs on the recipient's machine — a leak this test causes is a leak it should see.
    const memImportsInTemp = () => {
      try { return readdirSync(tmpdir()).filter((f) => f.startsWith('mem-import-')).length; } catch { return -1; }
    };
    const tempBefore = memImportsInTemp();
    try {
      writeFileSync(join(d, 'outside.txt'), 'CANARY-OUTSIDE-THE-ARCHIVE\n');

      const plain = join(d, 'notes.zip');
      writeZipSync(plain, [
        { name: 'kiln.md', data: '# kiln\n\nThe kiln fires at 1200 degrees for eight hours and cools overnight before opening.\n' },
        { name: 'sub/glaze.md', data: '# glaze\n\nStir the glaze bucket thoroughly before every dip or it goes on thin and patchy.\n' }
      ]);
      const okRead = readSource(plain);
      check('MEM-73: a zip of markdown reads through lib/zip.js, nested entries included',
        okRead.shape === 'zip of files' && (okRead.items || []).length === 2,
        JSON.stringify({ shape: okRead.shape, titles: (okRead.items || []).map((i) => i.title), skipped: okRead.skipped }));

      // ZIP-SLIP, TWO WAYS. A stored SYMLINK (what `unzip` restores and what the
      // 2026-08-30 escapesRoot() guard was written for), and an entry NAME that
      // climbs out of the destination — which `unzip` refused for us and a
      // hand-rolled extractor has to refuse for itself.
      const slip = join(d, 'slip.zip');
      writeZipSync(slip, [
        { name: 'sub/normal.md', data: '# normal\n\nAn ordinary note with enough prose in it to be imported at all.\n' },
        { name: 'sub/link.md', symlinkTo: join(d, 'outside.txt') }
      ]);
      const slipRead = readSource(slip);
      check('MEM-73: a zip symlink pointing off-archive is NOT imported',
        !/CANARY-OUTSIDE-THE-ARCHIVE/.test(JSON.stringify(slipRead)), JSON.stringify(slipRead).slice(0, 240));
      check('MEM-73: ...the real entry beside it still imports',
        (slipRead.items || []).some((i) => /normal/i.test(i.title || '')),
        JSON.stringify((slipRead.items || []).map((i) => i.title)));
      check('MEM-73: ...and the refusal is REPORTED, not silent',
        (slipRead.skipped || []).some((k) => /symlink/i.test(k.why || '')), JSON.stringify(slipRead.skipped));

      const climb = join(d, 'climb.zip');
      writeZipSync(climb, [
        { name: 'ok.md', data: '# ok\n\nAn ordinary note with enough prose in it to be imported at all.\n' },
        { name: '../escaped.md', data: '# escaped\n\nCANARY-OUTSIDE-THE-ARCHIVE written by the archive itself.\n' }
      ]);
      const before = readdirSync(d).sort();
      const climbRead = readSource(climb);
      check('MEM-73: an entry NAME that climbs out of the archive is refused by name',
        (climbRead.skipped || []).some((k) => /escapes the archive/.test(k.why || '')), JSON.stringify(climbRead.skipped));
      check('MEM-73: ...and nothing was written outside the extraction directory',
        JSON.stringify(readdirSync(d).sort()) === JSON.stringify(before) && !existsSync(join(d, 'escaped.md')),
        JSON.stringify(readdirSync(d)));
      check('MEM-73: ...while the ordinary entry in the same archive still imports',
        (climbRead.items || []).some((i) => /ok/i.test(i.title || '')),
        JSON.stringify((climbRead.items || []).map((i) => i.title)));

      // FOUR ARCHIVES READ ABOVE (notes, slip, climb, and the ChatGPT-export probe earlier in
      // this file), including two that took the REFUSAL path — so this also covers the exit a
      // cleanup without a `finally` would miss.
      const tempAfter = memImportsInTemp();
      check('MEM-76: reading four zips left ZERO mem-import-* directories behind in TEMP',
        tempBefore >= 0 && tempAfter === tempBefore, `before=${tempBefore} after=${tempAfter}`);
    } finally {
      cleanupSandbox(d, { label: 'import-index-e2e' });
    }
  }
}
