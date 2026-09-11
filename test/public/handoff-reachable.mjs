// test/public/handoff-reachable.mjs — CAN THE HANDOFF CORPUS BE REACHED AT ALL?
//
// 🟥 THE BUG. memoryRoots() (lib/config.js) dropped every handoff root on a bare
// `if (!process.env.MEMORY_DIR)`. That suppression exists so a fixture pointing MEMORY_DIR at a
// temp corpus measures THAT corpus and nothing else — a good rule. But it had no escape hatch, so
// an install that named MEMORY_HANDOFF_DIRS outright ALSO lost the corpus, and the project's own
// import instructions tell a new install to set both variables together. Result, measured on a
// second machine 2026-09-10: 17 handoff documents indexed nowhere, `index scope:'handoff'` refusing
// on an empty root list, searches returning nothing, and not one message anywhere saying the corpus
// had been DROPPED rather than being empty.
//
// It is the MEM-32 class — a write path and a read path disagreeing about whether a corpus exists —
// and it had already been fixed for the LIBRARY corpus eight lines away in the same function.
// Handoff never got the same treatment.
//
// WHAT THIS FILE ASSERTS, and why each check cannot pass vacuously:
//   * the truth table: which corpora memoryRoots() yields for six environments;
//   * THE INVARIANT that matters — handoffSuppressedReason() === null if and only if the handoff
//     roots are actually there. index, search and freshness all resolve handoff through
//     memoryRoots(), so if the predicate and the roots can disagree, the user is told one thing
//     and served another;
//   * end to end: with both variables set, a real index build and a real search return the handoff
//     document — the exact scenario the import doc prescribes;
//   * and the CONTROLS, which is where a fix like this goes wrong. "Always include handoff" would
//     pass every positive check above. So a bare MEMORY_DIR must STILL suppress (fixture isolation
//     is why the rule exists), MEMORY_HANDOFF_DIRS=0 must still be off, and a query for a term that
//     is in no document must return nothing — otherwise the retrieval check is measuring the
//     presence of any answer rather than the right one.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(dirname(dirname(HERE)));
const CFG = pathToFileURL(join(REPO, 'lib', 'config.js')).href;
const IDX = pathToFileURL(join(REPO, 'lib', 'index-store.js')).href;
const TOOL = pathToFileURL(join(REPO, 'tools', 'memory.js')).href;

// A child process per environment. MEMORY_DIR and the state root are read at import time, so
// mutating process.env in-process would ask the question of a module that had already answered it.
function ask(env, body) {
  const src =
    `const CFG = ${JSON.stringify(CFG)}, IDX = ${JSON.stringify(IDX)}, TOOL = ${JSON.stringify(TOOL)};\n` +
    `const out = (v) => process.stdout.write('@@' + JSON.stringify(v) + '@@');\n` +
    `const memoryTool = async () => { const m = await import(TOOL); const c = new Map();\n` +
    `  m.registerMemoryTools({ tool: (n, d, s, h) => c.set(n, h) });\n` +
    `  const W = new Set(['import','capture','index','demote','promote']);\n` +
    `  return async (a) => JSON.parse((await c.get(W.has(a.action) ? 'memory_write' : 'memory')(a)).content[0].text); };\n` +
    body;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env, cwd: REPO, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const m = /@@([\s\S]*)@@/.exec(r.stdout || '');
  if (!m) return { __nores: true, stderr: String(r.stderr || '').slice(-300), status: r.status };
  try { return JSON.parse(m[1]); } catch { return { __unparsable: m[1].slice(0, 300) }; }
}

// What memoryRoots() yields, and what the predicate SAYS it yields. Both, from one process, so the
// two can be compared rather than assumed to agree.
const PROBE = `const C = await import(CFG);
  const roots = C.memoryRoots();
  out({ corpora: [...new Set(roots.map((r) => r.corpus || (r.primary ? 'curated' : 'staging')))].sort(),
        handoffRoots: C.rootsForCorpus('handoff', roots).length,
        labels: roots.filter((r) => (r.corpus || '') === 'handoff').map((r) => r.label).sort(),
        reason: C.handoffSuppressedReason(),
        dirs: C.handoffDirs().length });`;

export async function handoffReachableTests({ check, group }) {
  group('(hr) the handoff corpus — reachable, or silently dropped? (MEM-32, second instance)');

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ar-handoff-')));
  const mem = join(tmp, 'mem');
  const hand = join(tmp, 'handoff');
  const home = join(tmp, 'home');
  for (const d of [mem, hand, home, join(tmp, 'store')]) mkdirSync(d, { recursive: true });

  // The curated note and the handoff document share NO vocabulary, so a hit on one is never
  // evidence about the other, and the query below cannot be answered from the wrong corpus.
  writeFileSync(join(mem, 'wheel-truing.md'),
    '---\nname: wheel-truing\ndescription: how to true a bicycle wheel\n---\n\n' +
    'Work opposite spoke pairs a quarter turn at a time until the rim runs straight.\n');
  writeFileSync(join(hand, 'HANDOFF-ferry-timetable.md'),
    '---\nname: HANDOFF-ferry-timetable\ndescription: state of the ferry timetable rewrite at handover\n---\n\n' +
    'The winter sailing schedule was migrated to the new timetable service. The Ardrossan berth ' +
    'still needs its tide-window override before the spring crossings resume.\n');

  const base = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    MEMORY_ROOT: tmp,
    MEMORY_INDEX: join(tmp, 'curated.json'),
    MEMORY_HANDOFF_INDEX: join(tmp, 'handoff.json'),
    MEMORY_OWN_STORE: join(tmp, 'store'),
    MEMORY_STAGING_INDEX: '0',
    MEMORY_PROJECTS_INDEX: '0',
    MEMORY_AUTHOR_CORPUS: '0',
    MEMORY_LIBRARY: '0',
    MEMORY_INLINE_REINDEX: '0',
    MEMORY_QUERY_SOURCE: 'test',
    MEMORY_MODEL_CACHE: join(REPO, '.model-cache'),
    MEMORY_DIR: '', MEMORY_HANDOFF_DIRS: '', MEMORY_HANDOFF_DOCS: ''
  };
  const env = (extra) => ({ ...base, ...extra });

  try {
    // ---- 1. THE FIX. Both variables set is what the import instructions prescribe.
    const both = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand }), PROBE);
    check('(hr1) 🟥 MEMORY_DIR + MEMORY_HANDOFF_DIRS — the handoff corpus is REACHABLE',
      both.handoffRoots === 1 && (both.corpora || []).includes('handoff'),
      JSON.stringify(both));
    check('(hr1) ...and the predicate agrees it is not suppressed',
      both.reason === null, String(both.reason));

    // ---- 2. A bare MEMORY_DIR still yields no handoff corpus. 🟥 READ THE SECOND ASSERTION
    // BEFORE TRUSTING THE FIRST: it is zero because there are no handoff DIRECTORIES to suppress,
    // not because the gate suppressed them. handoffDirs() falls back to DEFAULT_HANDOFF_DIRS,
    // which ships EMPTY, so with MEMORY_HANDOFF_DIRS unset the corpus is empty either way. This
    // check therefore proves the OUTCOME and says nothing about the gate — deleting the gate
    // entirely passes it. The gate is measured in (hr7), where it can actually bite.
    const bare = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: '' }), PROBE);
    check('(hr2) a bare MEMORY_DIR yields no handoff corpus — fixture isolation intact',
      bare.handoffRoots === 0 && !(bare.corpora || []).includes('handoff'),
      JSON.stringify(bare));
    check('(hr2) [why] ...and with DEFAULT_HANDOFF_DIRS shipping empty there was nothing to suppress',
      bare.dirs === 0, `handoffDirs() returned ${bare.dirs} — this check is no longer measuring what it says`);
    check('(hr2) ...and the predicate says WHY, naming the variable that opts back in',
      typeof bare.reason === 'string' && /MEMORY_HANDOFF_DIRS/.test(bare.reason), String(bare.reason));

    // ---- 3. The off-switches are still off. An opt-in must not be "any value at all".
    const off = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: '0' }), PROBE);
    check('(hr3) [control] MEMORY_HANDOFF_DIRS=0 is OFF, not an opt-in',
      off.handoffRoots === 0 && off.dirs === 0 && /switched off/.test(String(off.reason)), JSON.stringify(off));
    const docsOff = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand, MEMORY_HANDOFF_DOCS: '0' }), PROBE);
    check('(hr3) [control] MEMORY_HANDOFF_DOCS=0 switches the corpus off even with dirs named',
      docsOff.handoffRoots === 0 && /MEMORY_HANDOFF_DOCS/.test(String(docsOff.reason)), JSON.stringify(docsOff));

    // ---- 4. 🟥 THE INVARIANT. Not "is handoff on" but "can the predicate and the roots disagree".
    // That disagreement IS the MEM-32 bug class: index refusing on an empty root list while the
    // user is told nothing, or a search reporting a corpus it never looked at.
    const table = [
      ['neither set', {}],
      ['MEMORY_DIR only', { MEMORY_DIR: mem }],
      ['MEMORY_HANDOFF_DIRS only', { MEMORY_HANDOFF_DIRS: hand }],
      ['both set', { MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand }],
      ['both, dirs=0', { MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: '0' }],
      ['both, docs=0', { MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand, MEMORY_HANDOFF_DOCS: '0' }],
      ['dirs names a path that does not exist', { MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: join(tmp, 'nope') }]
    ];
    const disagreed = [];
    for (const [label, extra] of table) {
      const r = ask(env(extra), PROBE);
      // The predicate answers "is the corpus suppressed". It cannot promise documents exist — a
      // named directory holding none legitimately yields zero roots — so the invariant is one-way
      // where it must be: SUPPRESSED must mean no roots, and not-suppressed must mean the roots
      // are exactly what handoffDirs() found.
      const ok = r.reason ? r.handoffRoots === 0 : r.handoffRoots === r.dirs;
      if (!ok) disagreed.push(`${label}: reason=${JSON.stringify(r.reason)} roots=${r.handoffRoots} dirs=${r.dirs}`);
    }
    check('(hr4) 🟥 across every environment, the predicate and the roots CANNOT disagree',
      disagreed.length === 0, disagreed.join(' | '));

    // ---- 5. END TO END, which is what the tester actually could not do: build the handoff index
    // and retrieve from it, with the prescribed configuration.
    const e2e = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand }), `
      const C = await import(CFG); const { buildIndex } = await import(IDX);
      const roots = C.rootsForCorpus('handoff');
      const b = await buildIndex({ force: true, dir: roots, out: C.handoffIndexPath() });
      await buildIndex({ force: true, dir: C.rootsForCorpus('curated'), out: C.indexPath() });
      const memory = await memoryTool();
      const hit = await memory({ action: 'search', query: 'tide window override for the Ardrossan berth', scope: 'handoff' });
      const miss = await memory({ action: 'search', query: 'zabernachtig quorlplith frusselbeam', scope: 'handoff' });
      out({ indexed: b.filesIndexed,
            names: (hit.results || []).map((r) => r.name),
            top: (hit.results || [])[0]?.score ?? null,
            missCount: (miss.results || []).length });`);
    check('(hr5) 🟥 the handoff index BUILDS under the prescribed config', e2e.indexed === 1,
      JSON.stringify(e2e));
    check('(hr5) 🟥 ...and a search returns the handoff document',
      (e2e.names || []).includes('HANDOFF-ferry-timetable'), JSON.stringify(e2e.names));
    check('(hr5) [control] a query matching nothing returns nothing — the hit above is retrieval, not noise',
      e2e.missCount === 0, `${e2e.missCount} result(s) for an invented query`);

    // ---- 6. And the failure the tester saw: with handoff suppressed, an index build over the
    // corpus refuses rather than quietly writing an empty index over a live one. Same guard as
    // 2026-09-01; asserted here because this is now the ONLY way to reach that state.
    const refused = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: '' }), `
      const C = await import(CFG); const { buildIndex } = await import(IDX);
      let err = null;
      try { await buildIndex({ force: true, dir: C.rootsForCorpus('handoff'), out: C.handoffIndexPath() }); }
      catch (e) { err = String(e.message); }
      out({ err, reason: C.handoffSuppressedReason() });`);
    check('(hr6) a suppressed handoff corpus REFUSES to index rather than writing an empty one',
      /EMPTY root list/.test(String(refused.err)), String(refused.err));
    check('(hr6) ...and handoffSuppressedReason() is there to explain why, in the same words the user gets',
      /MEMORY_HANDOFF_DIRS/.test(String(refused.reason)), String(refused.reason));

    // ---- 7. 🟥 THE ONLY PLACE THE GATE ITSELF IS OBSERVABLE, and the reason this file exists in
    // the shape it does. Every check above passes with the gate DELETED, because a corpus with no
    // configured directories is empty whether or not anything suppressed it — I removed the gate
    // and watched all twelve go green, which is what a vacuous control looks like.
    //
    // The gate can only bite when handoffDirs() has something to return WITHOUT the environment
    // variable, i.e. when DEFAULT_HANDOFF_DIRS is not empty. That is not hypothetical: it ships
    // empty on purpose (nobody's directories belong in a library), but it is an ADVERTISED edit —
    // both the orphan alarm (lib/orphan-handoffs.js) and dream tell the user to "add its directory
    // to MEMORY_HANDOFF_DIRS / DEFAULT_HANDOFF_DIRS". The moment somebody takes that advice, the
    // isolation rule starts mattering and the opt-in has to keep working alongside it.
    //
    // So: plant a copy of the real config with that one constant populated, and ask it. Same
    // technique as state-root.mjs, for the same reason — the fact under test is baked in at module
    // scope, so the only honest way to vary it is to vary the module.
    {
      const pkg = join(tmp, 'planted');
      mkdirSync(join(pkg, 'lib'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'planted', type: 'module' }));
      for (const f of ['state-root.js', 'local-config.js']) copyFileSync(join(REPO, 'lib', f), join(pkg, 'lib', f));
      const src = readFileSync(join(REPO, 'lib', 'config.js'), 'utf8');
      const CONST = 'export const DEFAULT_HANDOFF_DIRS = [];';
      const planted = src.replace(CONST, `export const DEFAULT_HANDOFF_DIRS = [${JSON.stringify(hand)}];`);
      // If the constant is ever renamed or reformatted this must fail LOUDLY rather than plant an
      // unmodified copy and report three passes that measured the shipped empty default.
      check('(hr7) [self-check] the planted copy really was patched',
        planted !== src && planted.includes(JSON.stringify(hand)),
        'DEFAULT_HANDOFF_DIRS no longer matches the expected declaration — this whole case is vacuous');
      writeFileSync(join(pkg, 'lib', 'config.js'), planted);
      const PCFG = pathToFileURL(join(pkg, 'lib', 'config.js')).href;
      const askPlanted = (extra) => ask(env(extra),
        `const C = await import(${JSON.stringify(PCFG)});
         const roots = C.memoryRoots();
         out({ handoffRoots: C.rootsForCorpus('handoff', roots).length,
               reason: C.handoffSuppressedReason(), dirs: C.handoffDirs().length });`);

      const discovered = askPlanted({ MEMORY_DIR: '', MEMORY_HANDOFF_DIRS: '' });
      check('(hr7) [control] with a populated default, handoff IS discovered when MEMORY_DIR is unset',
        discovered.dirs === 1 && discovered.handoffRoots === 1 && discovered.reason === null,
        JSON.stringify(discovered));

      const isolated = askPlanted({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: '' });
      check('(hr7) 🟥 [control] ...and a bare MEMORY_DIR SUPPRESSES that discovered directory',
        isolated.dirs === 1 && isolated.handoffRoots === 0 && /MEMORY_HANDOFF_DIRS/.test(String(isolated.reason)),
        JSON.stringify(isolated) + ' — the gate is gone: a fixture would now measure someone else\'s handoff docs');

      const optedIn = askPlanted({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand });
      check('(hr7) 🟥 ...while naming MEMORY_HANDOFF_DIRS opts back in — the fix, with the gate live',
        optedIn.handoffRoots === 1 && optedIn.reason === null, JSON.stringify(optedIn));
    }


    // ---- 8. 🟥 N4 — SUPPRESSION MUST REACH THE INDEX LOAD, NOT ONLY THE ROOTS.
    //
    // The N3 fix gated rootsForCorpus(). It did not gate indexPathForCorpus(). So a handoff index
    // built while MEMORY_HANDOFF_DIRS was set kept ANSWERING after the variable was removed — the
    // predicate said "not searched" while the search returned documents. Found by a Windows tester
    // running the control this file's (hr2) describes, hours after N3 shipped; the N3 fix created
    // it. A suppression feature that still returns documents fails in the direction that matters.
    {
      const built = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand }), `
        const C = await import(CFG); const { buildIndex } = await import(IDX);
        const r = await buildIndex({ force: true, dir: C.rootsForCorpus('handoff'), out: C.handoffIndexPath() });
        out({ indexed: r.filesIndexed, path: C.handoffIndexPath() });`);
      check('(hr8) [setup] a handoff index exists on disk', built.indexed === 1, JSON.stringify(built));

      const after = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: '' }), `
        const C = await import(CFG); const fs = await import('node:fs');
        const memory = await memoryTool();
        const r = await memory({ action: 'search', query: 'tide window override for the Ardrossan berth', scope: 'handoff' });
        out({ fileStillOnDisk: fs.existsSync(${JSON.stringify('')} || C.handoffIndexPath() || 'x'),
              indexPath: C.indexPathForCorpus('handoff'),
              reason: C.corpusSuppressedReason('handoff'),
              names: (r.results || []).map((x) => x.name) });`);
      check('(hr8) 🟥 a SUPPRESSED corpus does not answer from the index already on disk',
        (after.names || []).length === 0, 'returned ' + JSON.stringify(after.names));
      check('(hr8) ...because indexPathForCorpus returns null for it, the same answer a switched-off corpus gives',
        after.indexPath === null, String(after.indexPath));
      check('(hr8) ...and the predicate and the index path AGREE',
        (after.reason ? after.indexPath === null : after.indexPath !== null), JSON.stringify({ reason: after.reason, path: after.indexPath }));

      // [control] the index file is untouched — suppression HIDES a corpus, it never deletes one.
      const back = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: hand }), `
        const memory = await memoryTool();
        const r = await memory({ action: 'search', query: 'tide window override for the Ardrossan berth', scope: 'handoff' });
        out({ names: (r.results || []).map((x) => x.name) });`);
      check('(hr8) [control] naming the variable again brings the SAME index back — nothing was deleted',
        (back.names || []).includes('HANDOFF-ferry-timetable'), JSON.stringify(back.names));
    }

    // ---- 9. the class, not the instance: one predicate answers for every corpus.
    {
      const r = ask(env({ MEMORY_DIR: mem, MEMORY_HANDOFF_DIRS: '' }), `
        const C = await import(CFG);
        const rows = {};
        for (const n of ['curated', 'handoff', 'books', 'projects', 'staging'])
          rows[n] = { reason: C.corpusSuppressedReason(n), path: C.indexPathForCorpus(n) };
        out(rows);`);
      check('(hr9) curated is never suppressed by configuration', r.curated?.reason === null, JSON.stringify(r.curated));
      check('(hr9) handoff and a library category BOTH answer through the one predicate',
        typeof r.handoff?.reason === 'string' && typeof r.books?.reason === 'string',
        JSON.stringify({ handoff: r.handoff?.reason, books: r.books?.reason }));
      const disagree = Object.entries(r).filter(([, v]) => v && v.reason && v.path !== null);
      check('(hr9) 🟥 NO corpus can be suppressed and still have an index path',
        disagree.length === 0, disagree.map(([k, v]) => k + ' -> ' + v.path).join(', '));
    }

  } finally {
    cleanupSandbox(tmp, { label: 'handoff-reachable' });
  }
}
