#!/usr/bin/env node
// scripts/check-release-clean.mjs — refuse to ship a tree that names anyone.
//
//   node scripts/check-release-clean.mjs <dir>        # exit 0 clean, 3 dirty
//   npm run check:release                             # this repo, minus what never ships
//
// WHY THIS EXISTS. The zip verifier checks FILENAMES — store/, *-index.json, .query-log,
// memories/ — and scrub-tree.mjs checks CONTENT but only knows credential classes. Neither
// looks for a brand, a colleague, a customer or an internal IP address, which is how a
// shareable build came to contain all four. A filename check cannot see inside a file, and
// that gap has already shipped a live credential once.
//
// TWO MODES, AND THE DIFFERENCE IS THE POINT. Memories get REDACTED — a marker replaces
// the secret and the document survives. Code gets REFUSED. You do not want
// [REDACTED:brand-term] sitting in public source; you want a human to remove the word and
// think about why it was there. So this script never edits anything. It reports and exits 3.
//
// The vocabulary lives in release-deny.json, which never spells the terms it detects.

import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSyncHidden } from '../lib/child.js';   // MEM-83: no console window on Windows

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv.slice(2).find((a) => !a.startsWith('-')) || ROOT;
const QUIET = process.argv.includes('--quiet');

// FAIL CLOSED, like secretsConfig() does: a checker that cannot read its own policy must
// refuse, not wave the tree through. A missing or broken deny-list is the one failure that
// would silently disable every check below.
let CFG;
try {
  CFG = JSON.parse(readFileSync(join(ROOT, 'release-deny.json'), 'utf8'));
  if (!Array.isArray(CFG.tokenHashesSha256) || !Array.isArray(CFG.patterns)) throw new Error('shape');
} catch (e) {
  console.error(`release-deny.json unreadable (${e.message}) — refusing to certify anything.`);
  process.exit(2);
}
const HASHES = new Set(CFG.tokenHashesSha256);
const ALLOW = new Set((CFG.allowExamples || []).map((s) => s.toLowerCase()));
const PATTERNS = CFG.patterns.map((p) => ({ ...p, re: new RegExp(p.re, p.flags || 'g') }));

// Never shipped, so never checked: build artefacts, vendored deps, and the corpus itself.
// NOTE: 'dist' is NOT skipped — dist/capture (a released copy of scripts/ + lib/) can appear there.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.model-cache', 'store', 'memories']);
// local-config.json is per-machine BY DEFINITION and gitignored by design — it is the
// place personal values are supposed to live, so scanning it reports the system working.
const SKIP_FILES = new Set(['release-deny.json', 'local-config.json']);

const isText = (p) => {
  const fd = openSync(p, 'r');
  try { const b = Buffer.alloc(8192); const n = readSync(fd, b, 0, 8192, 0); return !b.subarray(0, n).includes(0); }
  finally { closeSync(fd); }
};
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Every sub-token a term might hide inside: acme-storage-bot -> acme, storage, bot. */
function* tokens(text) {
  for (const raw of text.split(/[^A-Za-z0-9._+-]+/)) {
    if (!raw) continue;
    yield raw;
    for (const part of raw.split(/[-._/]+/)) if (part) yield part;
  }
}

const findings = [];
let scanned = 0;

function scan(path, rel) {
  const text = readFileSync(path, 'utf8');
  const hits = new Map();          // class/name -> example
  // EVERY match, not the first. Taking only `exec()`'s first hit meant one allowlisted
  // example at the top of a file silenced the pattern for the WHOLE file: allowing
  // an allowlisted example address in a comment hid a real personal address twenty lines
  // below it. A checker that stops at the first innocent match is a checker that can be
  // disarmed by putting something innocent first.
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      if (m[0] === '') { p.re.lastIndex++; continue; }   // zero-width guard
      if (ALLOW.has(m[0].toLowerCase())) continue;
      if (!hits.has(p.name)) hits.set(p.name, m[0]);
      else if (!String(hits.get(p.name)).includes(' +')) {
        hits.set(p.name, `${hits.get(p.name)} +more`);
      }
    }
  }
  for (const t of tokens(text)) {
    const low = t.toLowerCase();
    if (ALLOW.has(low)) continue;
    if (HASHES.has(sha(low))) hits.set('known-term', `<${low.length}-char term>`);
  }
  if (hits.size) {
    findings.push({ rel, hits: [...hits.entries()] });
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(entry)) walk(p); continue; }
    if (SKIP_FILES.has(entry)) continue;
    if (!st.size || !isText(p)) continue;
    scanned++;
    scan(p, relative(target, p));
  }
}

// CHECK WHAT SHIPS, NOT WHAT IS LYING AROUND. A release is built from `git archive HEAD`,
// so in a git tree the tracked files ARE the release and everything else is local noise —
// caches, indexes, query logs. Walking the directory instead flagged 264 files under
// .runtime-cache, none of which has ever left this machine, and buried the nine findings
// that mattered. Outside a git tree (a staged release directory) it falls back to walking.
let usedGit = false;
try {
  const tracked = execFileSyncHidden('git', ['-C', target, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0').filter(Boolean);
  if (tracked.length) {
    usedGit = true;
    for (const rel of tracked) {
      if (SKIP_FILES.has(basename(rel))) continue;
      if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
      const p = join(target, rel);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.size || !isText(p)) continue;
      scanned++;
      scan(p, rel);
    }
  }
} catch { /* not a git tree — fall through to the walker */ }
if (!usedGit) walk(target);

if (!QUIET || findings.length) {
  console.log(`release check: ${scanned} text files scanned under ${basename(target)}`);
}
for (const f of findings) {
  console.log(`  ${f.rel}`);
  for (const [name, sample] of f.hits) console.log(`      ${name}: ${sample}`);
}
if (findings.length) {
  console.log(`\nREFUSED: ${findings.length} file(s) name something that must not ship.`);
  console.log('Remove the term (do not redact it — public source should not carry markers),');
  console.log('or exclude the file from the release tree if it was never meant to ship.');
  process.exit(3);
}
console.log('clean — nothing in this tree matches the release deny vocabulary.');
process.exit(0);
