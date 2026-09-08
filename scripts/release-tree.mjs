#!/usr/bin/env node
// scripts/release-tree.mjs — apply packaging/release-exclude.json to a STAGED release tree.
//
//   node scripts/release-tree.mjs prune <staged-dir>   # exclude, re-add keeps, repoint npm scripts
//   node scripts/release-tree.mjs list-exclude         # one path per line
//   node scripts/release-tree.mjs list-keep            # one path per line
//
// WHY THIS EXISTS AS A UNIT. The exclusion list lived inside build-public-tree.sh as a bash
// array, so the OTHER release builder — build-zip.sh — had no way to read it and shipped
// `git archive HEAD` instead: a colleague's email address, two internal IPv4s, a NAS share
// path and 33 of the author's real memories, under a printed line saying "verified: no
// personal content". The list is now data (packaging/release-exclude.json) and this is the
// one piece of code that applies it, so the two artefacts cannot disagree about what is
// private. `mine` mode never calls it — that zip carries the corpus by design.
//
// FAIL CLOSED, like secretsConfig() and check-release-clean.mjs: a pruner that cannot read
// its own list must refuse, because the failure mode of a silently-empty exclusion list is
// an artefact that ships everything.

import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIST = join(ROOT, 'packaging', 'release-exclude.json');

let CFG;
try {
  CFG = JSON.parse(readFileSync(LIST, 'utf8'));
  if (!Array.isArray(CFG.exclude) || !Array.isArray(CFG.keep)) throw new Error('shape');
  if (!CFG.exclude.length) throw new Error('empty exclude list');
} catch (e) {
  console.error(`packaging/release-exclude.json unreadable (${e.message}) — refusing to prune anything.`);
  console.error('An empty or broken exclusion list would stage a release that ships everything.');
  process.exit(2);
}
const EXCLUDE = CFG.exclude.map((e) => (typeof e === 'string' ? e : e.path)).filter(Boolean);
const KEEP = CFG.keep.map((e) => (typeof e === 'string' ? e : e.path)).filter(Boolean);

// A path here must be RELATIVE and must not climb out of the staged tree: this script
// deletes directories, and the list is the only thing telling it what.
for (const p of [...EXCLUDE, ...KEEP]) {
  if (p.startsWith('/') || p.split('/').includes('..') || p.includes('\0')) {
    console.error(`release-exclude.json: '${p}' is not a safe relative path — refusing.`);
    process.exit(2);
  }
}

const cmd = process.argv[2];
if (cmd === 'list-exclude') { console.log(EXCLUDE.join('\n')); process.exit(0); }
if (cmd === 'list-keep')    { console.log(KEEP.join('\n')); process.exit(0); }
if (cmd !== 'prune') {
  console.error('usage: release-tree.mjs prune <staged-dir> | list-exclude | list-keep');
  process.exit(2);
}

const DEST = resolve(process.argv[3] || '');
if (!DEST || !existsSync(DEST) || !statSync(DEST).isDirectory()) {
  console.error(`release-tree.mjs prune: '${process.argv[3]}' is not a directory`);
  process.exit(2);
}
if (resolve(DEST) === resolve(ROOT)) {
  console.error('release-tree.mjs prune: that is the REPOSITORY, not a staged tree — refusing.');
  process.exit(2);
}

// ---- 1. remove what must not ship ------------------------------------------------
for (const path of EXCLUDE) {
  const p = join(DEST, path);
  if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); console.log(`    - ${path}`); }
}

// ---- 2. re-add the subtrees that ARE safe to ship --------------------------------
// Copied from the REPOSITORY, not from the staged tree, because step 1 has already
// deleted the parent. A missing keep path is fatal: it means the public suite — the only
// suite a recipient can run — would not ship, and the build would look fine.
for (const keep of KEEP) {
  const src = join(ROOT, keep);
  if (!existsSync(src)) {
    console.error(`    !! ${keep} not found in the repository — the release would ship without it`);
    process.exit(5);
  }
  mkdirSync(join(DEST, dirname(keep)), { recursive: true });
  cpSync(src, join(DEST, keep), { recursive: true });
  console.log(`    + ${keep} (re-added: safe to ship)`);
}

// ---- 3. no npm script may point at a file that is not here -----------------------
// `npm test` ran the private suite, which does not ship — a stranger's first instinct
// would have been an immediate ENOENT. Every script whose target was removed is dropped,
// and `test` is repointed at verify-stdio plus the public fixture suite, which are
// self-contained and pass on any machine.
const pkgPath = join(DEST, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const dropped = [];
  for (const [k, v] of Object.entries(pkg.scripts || {})) {
    for (const m of String(v).matchAll(/(?:scripts|test|packaging|ci-helpers)\/[A-Za-z0-9._-]+/g)) {
      if (!existsSync(join(DEST, m[0]))) { delete pkg.scripts[k]; dropped.push(`${k} -> ${m[0]}`); break; }
    }
  }
  pkg.scripts.test = 'node scripts/verify-stdio.js && node test/public/run-public-tests.js';
  pkg.scripts['test:stdio'] = 'node scripts/verify-stdio.js';
  pkg.scripts['test:full'] = 'node test/public/run-public-tests.js';
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  for (const d of dropped) console.log(`    - npm run ${d} (target not shipped)`);
  console.log('    ~ npm test -> verify-stdio + the public fixture suite');
}
process.exit(0);
