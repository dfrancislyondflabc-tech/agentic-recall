#!/usr/bin/env node
// scrub-tree.mjs — scrub every TEXT file in a staged tree, then PROVE it.
//
// ONE scrubber for anything that leaves this machine. build-zip.sh used to grep for
// one plaintext literal; that is both a weaker check than redact() and the reason the
// literal had to exist in the repo at all. This uses the hash route, so nothing here
// needs to know the secret it is removing.
//
// 🟥 The audit walks EVERY file, not the subset the scrubber chose. An audit that
// shares the scrubber's filter cannot catch a filter that is too narrow — the exact
// defect that shipped 8 unscrubbed files in backup-memory.js's first version.
//
//   node scripts/scrub-tree.mjs <dir> [--report-only]
import { readdirSync, statSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { redact } from '../lib/secrets.js';

const root = process.argv[2];
const REPORT_ONLY = process.argv.includes('--report-only');
// Importable without running: test/run-tests.js (a92) reads SHAPED_OK from here rather than
// keeping a second copy, because two lists that must agree are one list that will not.
const AS_CLI = Boolean(root) && !root.startsWith('--');
if (!AS_CLI && process.argv[1] && /scrub-tree\.mjs$/.test(process.argv[1])) {
  console.error('usage: scrub-tree.mjs <dir> [--report-only]'); process.exit(2);
}

const isText = (p) => {
  const fd = openSync(p, 'r');
  try { const b = Buffer.alloc(8192); const n = readSync(fd, b, 0, 8192, 0); return !b.subarray(0, n).includes(0); }
  finally { closeSync(fd); }
};

// Vendored deps and model weights are not ours and hold no corpus text; walking
// 284 MB of node_modules would make the check slow enough to get skipped.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.model-cache']);

// 🟥 FILES THAT ARE *ABOUT* CREDENTIALS, NOT FILES THAT CONTAIN ONE.
// secrets-exclude.json IS the detector's policy — its regexes are credential-shaped by
// definition, and scrubbing them ships a NEUTERED DETECTOR to whoever opens the zip.
// The test fixtures are synthetic strings whose whole job is to be redacted; scrubbing
// them turns the test into "[REDACTED] contains [REDACTED]", which passes while proving
// nothing. Blanket-scrubbing these DEGRADES the product without removing any secret.
//
// This is an exemption, so it is the dangerous kind of rule. It is therefore NOT a pass:
// these files are still checked by the HASH route, which recognises the actual known
// literals. Shaped-like-a-credential is allowed here; IS-a-known-credential never is.
//
// 🟥 2026-09-05 (MEM-64), found by the 1.7.1 zip agent: the two test/public files below were
// MISSING from this list, and the omission had shipped in every portable zip including 1.7.0.
// The cause was a REDACTION BUG, not a missing exemption — token-assignment swallowed the
// opening quote of a string literal and never re-emitted it, so a scrubbed assignment ended in
// an orphaned quote and the shipped suite could not be PARSED. Nothing caught it: --report-only
// passes because the negative lookaheads stop the marker re-matching, and check-release-clean.mjs
// looks for names, not syntax.
//
// 🟥 2026-09-05, later (MEM-65): the PATTERN IS NOW FIXED — token-assignment, password-colon and
// passwd-colon capture their delimiters and re-emit them. test/run-tests.js (a92) asserts the
// round trip for every rule in the vocabulary, parses every NON-exempt .js/.mjs after a scrub,
// and — separately, with the exemption BYPASSED — parses the two files below that MEM-64 added
// (SHAPED_OK_MUST_STILL_PARSE). So those two entries are no longer load-bearing for SYNTAX.
//
// The other four are a different case and always were: test/run-tests.js carries one FIRING
// SAMPLE for every rule in the vocabulary, PEM blocks included, and scrubbing it rewrites 9,263
// lines. A file the scrubber never touches owes nothing to a parse check, and demanding one
// would be a rule against having fixtures at all.
//
// They stay for the ORIGINAL reason, the one this list was invented for, and it is a stronger one:
// these files are redaction FIXTURES. Scrubbing them does not just neuter their assertions, it
// INVERTS them. Measured 2026-09-05 by scrubbing both and reading the result: campaign-lite's B.1
// block asks `storeText.includes(SECRETS.aws)`, and with SECRETS.aws scrubbed to a marker it asks
// whether the store contains `[REDACTED:credential-shaped]` — which it does, by design, so a clean
// run reports a LEAK that does not exist. run-public-tests.js's own SECRETS block inverts the same
// way, and its PEM fixture is eaten whole. An exemption that keeps a leak test honest is worth
// more than an exemption removed for tidiness.
//
// build-zip.sh's post-scrub parse check stays regardless: belt and braces, and it is the gate that
// would catch the next pattern nobody thought about.
export const SHAPED_OK = new Set([
  'secrets-exclude.json',
  'test/run-tests.js',
  'test/public/run-public-tests.js',
  'test/public/campaign-lite.mjs',
  'test/scrub-rule-text-preregistration.md',
  'test/backup-memory-preregistration.md',
]);

// The two entries 0d8a845 added for MEM-64. Named separately because their JUSTIFICATION changed
// with MEM-65: they were added because the scrub made them UNPARSEABLE, and that is now fixed —
// (a92) proves both still parse after a scrub. They stay for the fixture reason above, and this
// set is what lets the suite assert the difference instead of taking the comment's word for it.
export const SHAPED_OK_MUST_STILL_PARSE = new Set([
  'test/public/run-public-tests.js',
  'test/public/campaign-lite.mjs',
]);

if (!AS_CLI) { /* imported for SHAPED_OK only — do not walk anything */ } else {

let scrubbed = 0, scanned = 0;
const names = new Set(), files = [], exempt = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p); continue; }
    if (st.size > 8e6) continue;                       // model weights, caches
    let text; try { text = readFileSync(p, isText(p) ? 'utf8' : 'latin1'); } catch { continue; }
    scanned++;
    const r = redact(text);
    if (!r.hits || !r.hits.length) continue;
    const rel = relative(root, p);
    if (SHAPED_OK.has(rel)) {
      // The hash route still applies — a REAL known credential in one of these is a leak.
      if (r.hits.includes('known-literal')) {
        files.push(rel + ' :: known-literal (A REAL SECRET, not a pattern — refusing)');
        names.add('known-literal');
      } else exempt.push(rel);
      continue;
    }
    files.push(rel + ' :: ' + [...new Set(r.hits)].join(','));
    r.hits.forEach((h) => names.add(h));
    if (!REPORT_ONLY && isText(p)) { writeFileSync(p, r.text); scrubbed++; }
  }
};
walk(root);

if (REPORT_ONLY) {
  console.log(`   audit: ${scanned} files scanned, ${files.length} still carry credential patterns` +
    (exempt.length ? `; ${exempt.length} pattern-definition file(s) exempt but hash-checked (${exempt.join(', ')})` : ''));
  files.slice(0, 20).forEach((f) => console.log('     ' + f));
  process.exit(files.length ? 3 : 0);
}
console.log(`   scrubbed ${scrubbed} of ${scanned} file(s)` + (names.size ? ` (${[...names].join(', ')})` : ' — nothing matched') +
  (exempt.length ? `\n   exempt (pattern definitions, hash-checked): ${exempt.join(', ')}` : ''));
files.slice(0, 20).forEach((f) => console.log('     ' + f.split(' :: ')[0]));

}
