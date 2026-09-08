// test/public/state-root.mjs — WHERE DOES A PACKAGE INSTALL PUT ITS 35 MB?
//
// lib/state-root.js decides where the server writes the embedding model cache, the vector cache,
// the indexes and local-config.json. Before 1.8.0 that was always the code directory, which is
// correct for a git clone and destructive for `npx agentic-recall`: npm unpacks the code into a
// DISPOSABLE cache (~/.npm/_npx/<hash>), so the model would re-download and the corpus re-embed
// every time npm evicted it.
//
// The resolver is four rules in order, and the ORDER is the whole design — rule 2 (state that
// already exists beside the code) is checked BEFORE rule 3 (this looks like a package install)
// precisely so that every install predating this change keeps using the files it already has.
// Get that order wrong and a working install silently starts re-indexing into a new directory.
//
// WHY IT RUNS IN A SUBPROCESS. CODE_ROOT comes from import.meta.url, so the only honest way to
// ask "what would this file decide if it lived under node_modules?" is to put a copy there and
// ask it. Faking the path in-process would test a mock of the rule, not the rule.
//
// Each case carries a NEGATIVE CONTROL: the same tree with the one deciding fact removed. A test
// that passes both with and without the behaviour is not evidence of anything.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(dirname(dirname(HERE)));

// Plant a copy of the real resolver at `codeDir/lib/state-root.js` and ask it what it decides.
// `codeDir` is the would-be package root, so the copy goes one level down, exactly as it ships.
function askResolver(codeDir, env = {}) {
  mkdirSync(join(codeDir, 'lib'), { recursive: true });
  copyFileSync(join(REPO, 'lib', 'state-root.js'), join(codeDir, 'lib', 'state-root.js'));
  const script =
    `import('file://${join(codeDir, 'lib', 'state-root.js').replace(/\\/g, '/')}')` +
    `.then(m => process.stdout.write(m.stateRoot()))`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, MEMORY_ROOT: '', ...env }
  }).trim();
}

export async function stateRootTests({ check, group }) {
  group('(sr) the state root — where a package install writes');

  // realpath: on macOS the temp dir is /var/... which is a symlink to /private/var/..., and the
  // resolver reports the resolved path. Comparing the two forms fails on a difference that is
  // not the one under test.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ar-stateroot-')));
  const fakeHome = join(tmp, 'home');
  mkdirSync(fakeHome, { recursive: true });
  const homeEnv = { HOME: fakeHome, USERPROFILE: fakeHome };

  try {
    // ---- RULE 4: a plain directory is a git clone. Unchanged behaviour, and the control for
    // every case below — the ONLY difference in the next case is the node_modules path segment.
    const clone = join(tmp, 'a-git-clone');
    mkdirSync(clone, { recursive: true });
    check('(sr1) a plain checkout keeps writing beside the code',
      askResolver(clone, homeEnv) === clone,
      `got ${askResolver(clone, homeEnv)}, expected ${clone}`);

    // ---- RULE 3: the same tree, one path segment different.
    const npxRoot = join(tmp, 'cache', '_npx', 'deadbeef', 'node_modules', 'agentic-recall');
    mkdirSync(npxRoot, { recursive: true });
    const npxAnswer = askResolver(npxRoot, homeEnv);
    check('(sr2) an npx/node_modules install writes to ~/.agentic-recall, NOT the npm cache',
      npxAnswer === join(fakeHome, '.agentic-recall'),
      `got ${npxAnswer}`);
    check('(sr2) [control] ...and that answer is genuinely different from the code directory',
      npxAnswer !== npxRoot, 'resolver returned the code dir — rule 3 did not fire');

    // ---- RULE 2 beats RULE 3: the backward-compatibility clause. Same npx-shaped path, but
    // state already sits beside the code, so it must NOT be abandoned.
    const npxWithState = join(tmp, 'cache2', '_npx', 'feedface', 'node_modules', 'agentic-recall');
    mkdirSync(npxWithState, { recursive: true });
    writeFileSync(join(npxWithState, '.vector-cache.json'), '{}');
    check('(sr3) existing state beside the code wins over the package-install rule',
      askResolver(npxWithState, homeEnv) === npxWithState,
      `got ${askResolver(npxWithState, homeEnv)} — an existing install was abandoned`);

    // ---- RULE 1 beats everything.
    const override = join(tmp, 'explicit-root');
    mkdirSync(override, { recursive: true });
    check('(sr4) MEMORY_ROOT overrides even a package install',
      askResolver(npxRoot, { ...homeEnv, MEMORY_ROOT: override }) === override,
      'MEMORY_ROOT did not win');

    // ---- The marker set is a list, and a list is a place to drop an entry. Check one that is
    // NOT .vector-cache.json, so the rule is not accidentally about a single filename.
    const npxWithModel = join(tmp, 'cache3', '_npx', 'c0ffee', 'node_modules', 'agentic-recall');
    mkdirSync(join(npxWithModel, '.model-cache'), { recursive: true });
    check('(sr5) a downloaded model counts as existing state too, not just the vector cache',
      askResolver(npxWithModel, homeEnv) === npxWithModel,
      `got ${askResolver(npxWithModel, homeEnv)}`);

    // ---- The _npx BRANCH ON ITS OWN. Every realistic npx layout nests the package under
    // node_modules INSIDE the _npx directory, so `node_modules` alone catches it and the `_npx`
    // clause never fires — a mutation removing it survived the first version of this file. A
    // branch no test can reach is a branch nobody can trust, so this case reaches it: an _npx
    // path with no node_modules segment anywhere in it.
    const npxOnly = join(tmp, 'cache4', '_npx', 'ba5eba11', 'agentic-recall');
    mkdirSync(npxOnly, { recursive: true });
    const npxOnlyAnswer = askResolver(npxOnly, homeEnv);
    check('(sr7) an _npx path with no node_modules segment still relocates',
      npxOnlyAnswer === join(fakeHome, '.agentic-recall'), `got ${npxOnlyAnswer}`);
    check('(sr7) [control] ...and the same path outside _npx does NOT relocate',
      askResolver(join(tmp, 'cache4', 'plain', 'ba5eba11', 'agentic-recall'), homeEnv)
        !== join(fakeHome, '.agentic-recall'),
      'a plain directory was relocated — the rule is not about _npx at all');

    // ---- The real repo, resolved by the real import: this checkout must be unaffected.
    const live = await import('../../lib/state-root.js');
    check('(sr6) THIS checkout still resolves to itself — no live install is relocated',
      live.stateRoot() === REPO, `got ${live.stateRoot()}, expected ${REPO}`);
  } finally {
    // The shared helper, not a bare rmSync: on Windows a just-exited child can still hold
    // a handle, and a cleanup failure must warn rather than fail the run.
    cleanupSandbox(tmp, { label: 'state-root' });
  }
}
