#!/usr/bin/env node
// scripts/stamp-build.mjs — record WHICH COMMIT this artefact was built from.
//
// 🟥 WHY. lib/version.js reports `<version>@<sha>` so a bug report names a commit. It reads the
// live git HEAD when there is a checkout, and falls back to `.build-stamp.json` when there is not.
// Both distributions had that fallback wrong (measured 2026-09-10, on 2.0.1):
//
//   npm install  ->  2.0.1@unknown-sha(no-git)   — no stamp in the tarball at all
//   container    ->  2.0.1@1dce54b(packaged)     — a stamp COMMITTED to this repo months ago,
//                                                  carrying a sha from the PRIVATE repo that
//                                                  does not exist here. Unresolvable to a user.
//
// A version string that names a commit nobody can look up is worse than one that admits it does
// not know. So the stamp is now GENERATED, from THIS repo's HEAD, at pack time (`prepack`), and
// is no longer a tracked file that drifts.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

let sha, dirty = false;
try {
  sha = git('rev-parse', 'HEAD');
  dirty = git('status', '--porcelain').length > 0;
} catch {
  // No git, no stamp. Writing a placeholder would be the same lie in a different font.
  console.log('stamp-build: no git checkout — writing no stamp (the server will report no-git)');
  process.exit(0);
}

const stamp = {
  sha,
  builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  builtBy: 'scripts/stamp-build.mjs',
  ...(dirty ? { dirty: true } : {}),
  _comment: 'Generated at pack time from this repository HEAD. Read by lib/version.js ONLY when there is no .git.'
};
writeFileSync(join(ROOT, '.build-stamp.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log(`stamp-build: ${sha.slice(0, 7)}${dirty ? ' (DIRTY TREE)' : ''}`);
