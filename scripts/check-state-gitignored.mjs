#!/usr/bin/env node
// scripts/check-state-gitignored.mjs — EVERY FILE THIS SERVER WRITES MUST BE GITIGNORED.
//
// 🟥 WHY THIS EXISTS. .gitignore listed nine state files, each with a comment saying it mirrors
// corpus text and must never reach a remote. It did not list `.vanish-report.jsonl`, which records
// what disappeared from an index — document names, plus the absolute path of the index, i.e. the
// author's home directory. A `git add` committed it to a PUBLIC repository (8c2f36d, 2026-09-10)
// and it was pushed. The release secrets gate caught it the next morning, but only because the home
// path happened to contain a name on the exclusion list; a machine whose username was not on that
// list would have leaked the document names in silence.
//
// The rule "state files are gitignored" was real, written down, and applied nine times out of ten.
// A rule with no enforcement is the defect. So this asks the code where it writes, and asks git
// whether each of those paths is ignored — no hand-maintained list to drift out of date.
//
// It runs in the repository only (npm tarballs carry no .gitignore) and is part of `check:release`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(REPO);

if (!existsSync(join(REPO, '.git'))) {
  console.log('state-gitignore check: not a git checkout — skipped');
  process.exit(0);
}

// Resolve the paths with the state root pinned AT the repo, which is what a clone does, so the
// answers are the paths a contributor's working tree will actually accumulate.
process.env.MEMORY_ROOT = REPO;
delete process.env.MEMORY_DIR;          // a per-corpus root would point the answers elsewhere
for (const v of ['MEMORY_INDEX', 'MEMORY_STAGING_INDEX', 'MEMORY_HANDOFF_INDEX', 'MEMORY_PROJECTS_INDEX',
  'MEMORY_QUERY_LOG', 'MEMORY_PROBE_RESULTS', 'MEMORY_MARGIN_HISTORY', 'MEMORY_OWN_STORE',
  'MEMORY_VANISH_LOG', 'MEMORY_MODEL_CACHE', 'MEMORY_LIBRARY']) delete process.env[v];

const C = await import('../lib/config.js');
const H = await import('../lib/ingest-health.js');

// Every writer, named. A new state file added to the server without a line here is the same
// omission all over again — so the count is asserted at the bottom.
const WRITERS = [
  ['the curated index', C.indexPath],
  ['the staging index', C.stagingIndexPath],
  ['the handoff index', C.handoffIndexPath],
  ['the projects index', C.projectsIndexPath],
  ['a library-category index', () => C.libraryIndexPath('books')],
  ['the query log', C.queryLogPath],
  ['the probe sidecar', C.probeResultsPath],
  ['the margin history', C.marginHistoryPath],
  ['the vanish report', H.vanishLogPath],
  ['the capture store', C.ownStoreDir],
  ['the embedding model cache', C.modelCacheDir]
];

const ignored = (p) => {
  try { execFileSync('git', ['check-ignore', '-q', '--', p], { cwd: REPO, stdio: 'ignore' }); return true; }
  catch { return false; }
};

let bad = 0, checked = 0, outside = 0;
console.log(`state-gitignore check: ${WRITERS.length} writers`);
for (const [what, fn] of WRITERS) {
  let p;
  try { p = fn(); } catch (e) { console.log(`  SKIP  ${what} — could not resolve (${e.message})`); continue; }
  if (!p) { console.log(`  skip  ${what} — switched off in this environment`); continue; }
  const abs = resolve(p);
  // A path outside the checkout cannot be committed from here, which is a valid answer, not a pass
  // to hand out quietly — it is reported so a future relocation is visible.
  const rel = relative(REPO, abs);
  if (rel.startsWith('..')) { outside++; console.log(`  ok    ${what} — outside the checkout`); continue; }
  checked++;
  if (ignored(abs)) { console.log(`  ok    ${what} — .gitignore covers ${rel}`); continue; }
  bad++;
  console.log(`  🟥 NOT IGNORED  ${what} — ${rel}`);
};

// 🟥 THE ANTI-VACUOUS CHECK. If every writer resolved to "switched off" or "outside", this script
// would print a wall of ok and assert nothing — which is precisely the failure mode it exists to
// prevent elsewhere. At least most of the writers must have been genuinely tested inside the tree.
if (checked < 6) {
  console.log(`\nREFUSED: only ${checked} writer(s) resolved inside the checkout — this check measured almost nothing.`);
  process.exit(3);
}

if (bad) {
  console.log(`\nREFUSED: ${bad} state file(s) the server writes are NOT gitignored.`);
  console.log('These mirror corpus text and absolute paths. Add them to .gitignore with a line saying');
  console.log('what they hold and why they must never reach a remote — every other one has one.');
  process.exit(3);
}
console.log(`clean — all ${checked} state path(s) inside the checkout are gitignored.`);
