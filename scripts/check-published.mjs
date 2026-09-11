#!/usr/bin/env node
// scripts/check-published.mjs — verify the artefact npm ACTUALLY SERVES, not the tree we built.
//
//   node scripts/check-published.mjs [version]      (default: the version in package.json)
//
// 🟥 WHY. Every packaging defect found in the week this was written was invisible to `npm test` and
// obvious in the tarball:
//
//   * .build-stamp.json was absent, so an install reported `2.0.1@unknown-sha(no-git)`
//   * secrets-exclude.json was left out of a derived copy — the server then failed CLOSED
//   * the lockfile said 1.7.5 while package.json said 2.0.1
//   * a state file with a home path in it was committed to the public repo
//
// And the sharpest case: a tester reported "the README is not version-pinned" from a copy of the
// PREVIOUS release, and neither of us could say which artefact we were looking at until three
// tarballs had been downloaded by hand. `--version` proves which code RUNS; it proves nothing about
// which README you are reading. This script removes the ambiguity in one command.
//
// It makes network calls, so it is not part of `npm test`. Run it AFTER publishing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = PKG.name;
const WANT = process.argv[2] || PKG.version;

let failures = 0;
const ok = (s) => console.log(`  ok    ${s}`);
const bad = (s) => { failures++; console.log(`  🟥    ${s}`); };

console.log(`published-artefact check: ${NAME}@${WANT}`);

const T = mkdtempSync(join(tmpdir(), 'ar-published-'));
let dir;
try {
  execFileSync('npm', ['pack', `${NAME}@${WANT}`, '--pack-destination', T], { encoding: 'utf8', stdio: 'pipe' });
  const tgz = execFileSync('ls', [T], { encoding: 'utf8' }).trim().split('\n').find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['xzf', join(T, tgz), '-C', T]);
  // 🟥 AND INSTALL IT, the way a user does. The first version ran index.js straight out of the
  // extracted tarball and every execution died on `Cannot find package '@modelcontextprotocol/sdk'`
  // — no node_modules. That reported as four failures of the PACKAGE when it was a failure of this
  // script. A gate whose own setup is broken manufactures false findings, which is worse than
  // finding nothing.
  const proj = join(T, 'install');
  execFileSync('mkdir', ['-p', proj]);
  execFileSync('npm', ['init', '-y'], { cwd: proj, stdio: 'pipe' });
  execFileSync('npm', ['install', join(T, tgz), '--no-audit', '--no-fund'], { cwd: proj, stdio: 'pipe' });
  dir = join(proj, 'node_modules', NAME);
  ok(`downloaded and installed ${tgz} from the registry`);
} catch (e) {
  console.log(`  🟥    could not fetch ${NAME}@${WANT} from the registry: ${e.message}`);
  process.exit(3);
}

// ---- 1. it is the version it claims to be -------------------------------------------------
const shipped = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
shipped.version === WANT ? ok(`package.json says ${shipped.version}`) : bad(`package.json says ${shipped.version}, expected ${WANT}`);

// ---- 2. 🟥 EVERY DOCUMENTED CONFIG BLOCK IS VERSION-PINNED --------------------------------
// An unpinned `npx` config crosses a breaking major on a cold resolve. This is N1, and it is the
// claim the tester and the author could not settle without downloading tarballs.
const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
if (!readme) bad('no README.md in the tarball');
else {
  const major = String(shipped.version).split('.')[0];
  const bare = [...readme.matchAll(new RegExp(`"-y",\\s*"${NAME}"`, 'g'))].length;
  const pinned = [...readme.matchAll(new RegExp(`${NAME}@${major}`, 'g'))].length;
  bare === 0 ? ok(`no unpinned "${NAME}" config block in the README`) : bad(`${bare} UNPINNED config block(s) in the README — a cold npx resolve crosses a major`);
  pinned > 0 ? ok(`${pinned} pinned reference(s) to ${NAME}@${major}`) : bad(`the README never names ${NAME}@${major}`);
}

// ---- 3. every file the code OPENS at runtime is in the tarball -----------------------------
// Derived by asking, not by a hand-list that drifts: these are the paths resolved against the
// CODE directory, so they must travel with the code.
// Derived from the SHIPPED package.json, never a hand-list here: a hand-list drifts, and the
// first version of this script asked 2.0.1 for lib/doctor.js — a file that only exists in a LATER
// release — and reported its absence as a defect. The question is "does the tarball contain what
// this version says it contains", not "what does the newest tree have".
const binEntry = typeof shipped.bin === 'string' ? shipped.bin : Object.values(shipped.bin || {})[0];
for (const f of [binEntry, 'secrets-exclude.json'].filter(Boolean)) {
  existsSync(join(dir, f)) ? ok(`ships ${f}`) : bad(`MISSING from the tarball: ${f}`);
}
for (const entry of (shipped.files || [])) {
  const clean = String(entry).replace(/\/$/, '');
  if (!existsSync(join(dir, clean))) bad(`package.json files[] names "${entry}" but the tarball has no such path`);
}
ok(`every files[] entry is present (${(shipped.files || []).length} checked)`);
existsSync(join(dir, '.build-stamp.json'))
  ? ok('ships .build-stamp.json (an install can name the commit it was built from)')
  : bad('no .build-stamp.json — installs will report unknown-sha(no-git)');

// ---- 4. it runs, and answers --------------------------------------------------------------
try {
  const v = execFileSync(process.execPath, [join(dir, 'index.js'), '--version'], { encoding: 'utf8', timeout: 60000 }).trim();
  v.includes(WANT) ? ok(`--version reports ${v}`) : bad(`--version reported "${v}", expected ${WANT}`);
} catch (e) { bad(`--version failed: ${e.message}`); }

// --doctor arrived after 2.0.1, so ask for it only when the shipped tree has it. Demanding a
// feature of a release that predates it is how the file-list check above produced a false finding.
if (!existsSync(join(dir, 'lib', 'doctor.js'))) {
  console.log(`  skip  --doctor: not in ${WANT} (it ships from the release after 2.0.1)`);
} else try {
  const d = execFileSync(process.execPath, [join(dir, 'index.js'), '--doctor'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, MEMORY_DIR: T, MEMORY_ROOT: T, MEMORY_STAGING_INDEX: '0', MEMORY_PROJECTS_INDEX: '0', MEMORY_HANDOFF_INDEX: '0', MEMORY_LIBRARY: '0' }
  });
  /CORPORA/.test(d) ? ok('--doctor runs from the published tarball') : bad('--doctor produced no report');
} catch (e) { bad(`--doctor failed: ${e.message}`); }

console.log('');
if (failures) { console.log(`REFUSED: ${failures} problem(s) in the PUBLISHED artefact. The tree being correct is not evidence.`); process.exit(3); }
console.log('clean — what npm serves matches what this repo intends.');
