// scripts/release-notes.mjs — print one version's CHANGELOG section, for `gh release --notes-file`.
//
// 🟥 WHY THIS EXISTS. The v1.8.1 release notes claimed "Verified on macOS, Linux x86_64 and
// Windows ... installing from npm" while ZERO CI jobs installed from the registry. No gate caught
// it, and no gate could have: that sentence was typed straight into the GitHub release UI and was
// never in the repository at all. `git log -S` on it returns nothing.
//
// A claim that lives outside the repo cannot be tested, reviewed, or diffed. So release notes are
// now generated FROM CHANGELOG.md — a committed file that check-claims.mjs reads and the suite
// gates — and the GitHub release becomes a copy of reviewed text rather than a place to write new
// unreviewed text.
//
//   node scripts/release-notes.mjs 1.8.1 > /tmp/notes.md
//   gh release create v1.8.1 --notes-file /tmp/notes.md

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2] || JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

const start = text.indexOf(`## [${version}]`);
if (start === -1) {
  console.error(`release-notes: CHANGELOG.md has no section for ${version}. ` +
    `Write the entry first — the release notes are the changelog, not a second draft of it.`);
  process.exit(3);
}
const next = text.indexOf('\n## [', start + 1);
const body = text.slice(start, next === -1 ? undefined : next).trim();
const firstNl = body.indexOf('\n');
console.log(body.slice(firstNl + 1).trim());
