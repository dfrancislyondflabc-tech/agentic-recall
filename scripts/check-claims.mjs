// scripts/check-claims.mjs — DOES A VERIFICATION CLAIM HAVE A JOB BEHIND IT?
//
// 🟥 THE MISTAKE THIS EXISTS FOR, made twice in one day, 2026-09-08/09.
//
//   1. The README was rewritten to lead with `npx -y agentic-recall` in the same commit that made
//      the package publishable — before it was published. For hours the first command in the
//      README returned a 404. Closed by scripts/check-docs-install.mjs.
//
//   2. The v1.8.1 release notes said "Verified on macOS, Linux x86_64 and Windows ... installing
//      from npm". ZERO CI jobs installed from the registry: every job did actions/checkout then
//      `npm install` on the working tree. Windows-from-npm had been verified by nobody. It broke
//      within hours of publishing (npx ECOMPROMISED on Node 24, npm/cli#8710) and a person found
//      it, not the suite.
//
// Both are the same error: verifying something ADJACENT to the claim, then making the claim. The
// first gate checks docs against the world. This one checks claims against the TEST MATRIX —
// if the docs say a platform or an install method is verified, a job has to exercise it.
//
// Deliberately narrow. It does not parse English. It looks for explicit verification sentences,
// pulls the platforms and install methods out of them, and asks whether the workflow covers each.
// A vague sentence is not caught, and that is the right trade: a gate that guesses at meaning
// generates false failures and gets switched off.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CI = existsSync(join(ROOT, '.github/workflows/ci.yml'))
  ? readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8') : '';

const DOCS = ['README.md', 'CHANGELOG.md']
  .filter((f) => existsSync(join(ROOT, f)))
  .map((f) => ({ file: f, text: readFileSync(join(ROOT, f), 'utf8') }));

// What the workflow actually covers, read from the file rather than assumed.
const covers = {
  windows: /windows-latest/.test(CI),
  macos:   /macos-latest/.test(CI),
  linux:   /ubuntu-latest/.test(CI),
  // 🟥 THE DISTINCTION THAT WAS MISSED. A checkout job proves the SOURCE works. It says nothing
  // about the published package, because it never contacts the registry.
  npx:     /npx\s+-y\s+agentic-recall/.test(CI),
  global:  /npm\s+i(?:nstall)?\s+-g\s+agentic-recall/.test(CI)
};

// Sentences that CLAIM verification. Anything else is prose and is left alone.
//
// 🟥 NEWLINES ARE COLLAPSED FIRST. The first cut used [^.\n], so a claim wrapped across lines was
// truncated at the line break: "Verified on macOS, Linux and Windows ... and installed" matched,
// while "from npm" on the NEXT line did not, so the gate demanded only platform coverage and
// passed. It survived its own mutation test twice before this was found. Markdown wraps prose;
// a gate that reads prose has to unwrap it first.
const CLAIM = /(?:verified|proved|tested)\b[^.]{0,300}/gi;
const flatten = (t) => t.replace(/\s*\n\s*/g, ' ');

const failures = [];
let claimsSeen = 0;

for (const { file, text } of DOCS) {
  for (const m of flatten(text).matchAll(CLAIM)) {
    const sentence = m[0];
    claimsSeen++;
    const wants = [];
    if (/\bwindows\b/i.test(sentence))                      wants.push(['windows', 'a windows-latest job']);
    if (/\bmacos\b|\bmac os\b/i.test(sentence))             wants.push(['macos',   'a macos-latest job']);
    if (/\blinux\b|\bubuntu\b/i.test(sentence))             wants.push(['linux',   'an ubuntu-latest job']);
    if (/from npm\b|\bnpx\b/i.test(sentence))               wants.push(['npx',     'a job running `npx -y agentic-recall`']);
    if (/\bnpm i(?:nstall)? -g\b|global install/i.test(sentence)) wants.push(['global', 'a job running `npm i -g agentic-recall`']);

    for (const [key, need] of wants) {
      if (!covers[key]) {
        failures.push(`${file}: claims "${sentence.trim().slice(0, 110)}…"\n` +
          `      but the workflow has no ${need}. Either add the job, or stop claiming it.`);
      }
    }
  }
}

console.log(`claims check: ${claimsSeen} verification sentence(s) across ${DOCS.length} doc(s)`);
for (const [k, v] of Object.entries(covers)) console.log(`  ${v ? 'ok   ' : 'ABSENT'} CI covers: ${k}`);

// CONTROL: if the workflow covers nothing, every claim would pass vacuously by having nothing to
// check against — which is exactly backwards. Fail loudly instead.
if (!Object.values(covers).some(Boolean)) {
  console.error('\n  FAIL  the workflow covers NOTHING this gate knows how to check — it cannot be trusted.');
  process.exit(3);
}

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n${failures.length} claim(s) with no test behind them.`);
  process.exit(3);
}
console.log('clean — every verification claim has a job behind it.');
