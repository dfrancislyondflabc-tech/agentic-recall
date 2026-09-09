// test/public/cli-flags.mjs — THE FLAGS A PACKAGE INSTALL MAKES REACHABLE.
//
// From 1.8.0 this ships as a `bin`, so `npx -y agentic-recall --version` is the first command a
// person runs to check the install worked. Before that, an unknown argument was IGNORED: the
// process started a full MCP server on a closed stdin and exited 0. That is indistinguishable
// from success at the shell, and it is what made the README's own `--version` line false when it
// was written — which is why these checks exist rather than a note saying "seems to work".
//
// The controls matter more than the assertions here. "Exit 0 and print something" was already
// true of the broken behaviour, so each check pins the thing that was NOT true: that the output
// is the version and nothing else, and that an unrecognised flag is REFUSED rather than absorbed.

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ENTRY = join(REPO, 'index.js');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [ENTRY, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? null, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

export async function cliFlagsTests({ check, group }) {
  group('(cli) the flags a bin install makes reachable');

  const v = run(['--version']);
  check('(cli1) --version exits 0', v.code === 0, `exit ${v.code}`);
  check('(cli1) ...and prints a version, on stdout, and nothing else',
    /^\d+\.\d+\.\d+/.test(v.stdout.trim()) && v.stdout.trim().split('\n').length === 1,
    JSON.stringify(v.stdout.slice(0, 120)));
  // A package install has no git. The string must still read as a version and not as an error:
  // "1.8.0@unknown-sha(no-git)" is technically true and looks to a new user like a failed install.
  check('(cli1) ...and never reports a missing commit as if something were wrong',
    !/unknown-sha|no-git/.test(v.stdout), JSON.stringify(v.stdout.trim()));
  check('(cli1) [control] ...and did NOT start a server — no scheduler banner on stderr',
    !/scheduler ON/.test(v.stderr), v.stderr.slice(0, 160));

  check('(cli2) -v is the same as --version',
    run(['-v']).stdout.trim() === v.stdout.trim(), 'short and long form disagree');

  const h = run(['--help']);
  check('(cli3) --help exits 0 and explains what this is',
    h.code === 0 && /MCP server/.test(h.stdout) && /MEMORY_DIR/.test(h.stdout),
    `exit ${h.code}`);
  // --help prints the version too, and it went on printing the raw string after --version was
  // cleaned up — one fix, two call sites, and only the second was checked.
  check('(cli3) ...and its version line matches --version, not the raw internal string',
    !/unknown-sha|no-git/.test(h.stdout), JSON.stringify(h.stdout.split('\n')[0]));

  const bad = run(['--not-a-real-flag']);
  check('(cli4) an unknown flag is REFUSED, not ignored',
    bad.code === 2, `exit ${bad.code} — an ignored flag looks like success`);
  check('(cli4) ...and says which flag, and where to look',
    /--not-a-real-flag/.test(bad.stderr) && /--help/.test(bad.stderr),
    JSON.stringify(bad.stderr.slice(0, 160)));

  // ---- REFUSING TO RUN UNCONFIGURED -----------------------------------------------------------
  //
  // 🟥 THE BUG. `--help` said MEMORY_DIR was "Required; never guessed" and it was guessed: unset,
  // it fell back to ./memories beside the code and the server started anyway, reporting a corpus
  // at a path that did not exist. That would be a cosmetic lie except that the heartbeat and the
  // capture walker do NOT depend on MEMORY_DIR — they read Claude's transcripts and write captured
  // exchanges regardless. Measured on a Windows install: 748 exchanges captured from real
  // transcripts with no corpus configured. A typo in an env var quietly became "embed my entire
  // chat history somewhere I never chose".
  //
  // The two REGRESSION cases matter as much as the fix: a set MEMORY_DIR must still start, and so
  // must the zip layout, where ./memories exists beside the code and no env var is set. Refusing
  // either would break every working install to fix an unconfigured one.
  group('(cfg) an unconfigured server refuses to start');

  const boot = (env, cwd = REPO) => {
    const e = { ...process.env, ...env };
    if (env.MEMORY_DIR === undefined) delete e.MEMORY_DIR;
    return spawnSync(process.execPath, [join(cwd, 'index.js')], {
      env: e, encoding: 'utf8', timeout: 25000, input: '', cwd
    });
  };

  const home = mkdtempSync(join(tmpdir(), 'cfg-home-'));
  const corpus = mkdtempSync(join(tmpdir(), 'cfg-corpus-'));
  writeFileSync(join(corpus, 'a.md'),
    '---\nname: a\ndescription: a\nmetadata:\n  type: reference\n---\nbody\n');

  const unset = boot({ HOME: home, USERPROFILE: home, MEMORY_DIR: undefined });
  check('(cfg1) unset MEMORY_DIR with no fallback folder is REFUSED',
    /REFUSING TO START/.test(unset.stderr || ''), `exit ${unset.status}`);
  check('(cfg1) ...with a config exit code, not a crash',
    unset.status === 78, `exit ${unset.status} (want 78 = EX_CONFIG)`);
  check('(cfg1) ...and it names the variable and the path it checked',
    /MEMORY_DIR is not set/.test(unset.stderr || '') && /does not exist/.test(unset.stderr || ''),
    (unset.stderr || '').slice(0, 160));
  check('(cfg1) 🟥 ...and NOTHING started writing — no capture walker',
    !/scheduler ON/.test(unset.stderr || ''),
    'the capture scheduler started on an unconfigured server');

  // ---- the two regressions ----
  const set = boot({ HOME: home, USERPROFILE: home, MEMORY_DIR: corpus });
  check('(cfg2) REGRESSION — a set MEMORY_DIR still starts',
    !/REFUSING TO START/.test(set.stderr || ''), (set.stderr || '').slice(0, 140));
  check('(cfg2) [control] ...and that run really did reach startup',
    /scheduler ON|Connected/.test(set.stderr || ''), 'never reached startup — check is vacuous');

  // 🟥 THE THIRD CASE, and a mutation that made the server refuse whenever the folder was absent
  // — regardless of whether MEMORY_DIR was set — survived without it. A MEMORY_DIR that is SET but
  // points at nothing is a DIFFERENT situation: the user did configure it, and the path may simply
  // be an unmounted drive or a folder they have not made yet. That case must still start, and be
  // caught later by the indexer, whose message names the root it checked and the likely cause.
  // Refusing at startup instead would replace a precise diagnosis with a blunt one.
  const setButMissing = boot({
    HOME: home, USERPROFILE: home, MEMORY_DIR: join(corpus, 'does-not-exist-yet')
  });
  check('(cfg3) a SET MEMORY_DIR pointing at a missing folder still starts',
    !/REFUSING TO START/.test(setButMissing.stderr || ''),
    'refused a configured-but-absent path — that diagnosis belongs to the indexer');
  check('(cfg3) [control] ...and that run reached startup, so the check is not vacuous',
    /scheduler ON|Connected/.test(setButMissing.stderr || ''),
    (setButMissing.stderr || '').slice(0, 140));

  cleanupSandbox(home, { label: 'cfg-home' });
  cleanupSandbox(corpus, { label: 'cfg-corpus' });

  // Nothing to remove; the helper is imported so this file obeys the same cleanup rule as its
  // siblings, and calling it with no directory is a no-op by contract.
  cleanupSandbox(null);
}
