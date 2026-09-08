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

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
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

  // Nothing to remove; the helper is imported so this file obeys the same cleanup rule as its
  // siblings, and calling it with no directory is a no-op by contract.
  cleanupSandbox(null);
}
