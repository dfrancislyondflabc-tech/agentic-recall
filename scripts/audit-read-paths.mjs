#!/usr/bin/env node
// scripts/audit-read-paths.mjs — no shipped file may read a path that did not ship.
//
//   node scripts/audit-read-paths.mjs <dir>     # exit 0 clean, 4 if something reads a ghost
//
// WHY THIS EXISTS. A public tree is built by EXCLUSION, and the exclusions are maintained by
// hand. Twice now a script survived the cut while the fixture it reads did not: four measurement
// harnesses the first time, and scripts/eval-state.js the second — which reached a public clone
// and made `npm run eval:state` die with ENOENT on a fresh install.
//
// Both times the list was re-read and both times the miss survived, because reading a list is
// how the list got wrong in the first place. So the tree is ASKED instead: every readFileSync,
// readdirSync and existsSync argument that names a literal path is resolved against the staged
// tree, and anything pointing at a file that is not there fails the build.
//
// Deliberately narrow: only join(...) calls built entirely from string literals are checked. A
// path assembled from variables cannot be resolved statically and is skipped rather than guessed
// at — a checker that invents findings gets switched off, which is worse than one that misses some.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

const root = resolve(process.argv[2] || '.');
// Reads that are deliberately optional and wrapped in try/catch. Each needs a reason, so the
// list cannot quietly become a place to hide real breakage.
const GUARDED = new Map([
  ['lib/benchmark-strings.js', 'readdir of test/ is inside try/catch — "no test dir = no benchmark files"']
]);
const findings = [];
let scanned = 0;

const LITERAL = /['"`]([^'"`]+)['"`]/g;
// readFileSync/readdirSync THROW when the path is missing; existsSync is the API you use
// precisely BECAUSE it may be missing, so it is not a defect and is not checked.
const CALL = /(?:readFileSync|readdirSync)\(\s*join\(([^)]*)\)/g;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(js|mjs)$/.test(entry)) continue;
    scanned++;
    const src = readFileSync(p, 'utf8');
    for (const call of src.matchAll(CALL)) {
      const args = call[1];
      // Any non-literal argument means the path is dynamic — skip rather than guess.
      if (/\b(?:[A-Za-z_$][\w$]*)\s*(?:,|\))/.test(args.replace(LITERAL, ''))) {
        const bare = args.replace(LITERAL, '').replace(/[\s,]/g, '');
        if (bare && !/^(?:__dirname|HERE|ROOT|dir)$/.test(bare)) continue;
      }
      const parts = [...args.matchAll(LITERAL)].map((m) => m[1]);
      if (!parts.length) continue;
      const rel = parts.join('/').replace(/\/+/g, '/');
      if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel === '.') continue;
      const fromFile = resolve(dirname(p), rel);
      const fromRoot = resolve(root, rel.replace(/^\.\.\//, ''));
      if (!existsSync(fromFile) && !existsSync(fromRoot)) {
        const rp = relative(root, p);
        if (GUARDED.has(rp)) continue;
        findings.push(`${rp} reads ${rel}`);
      }
    }
  }
}

walk(root);
if (findings.length) {
  console.error(`  REFUSED — ${findings.length} shipped file(s) read a path that is not in the tree:`);
  for (const f of [...new Set(findings)]) console.error(`    ${f}`);
  process.exit(4);
}
console.log(`  clean — ${scanned} shipped script(s) scanned, every literal path they read is present`);
