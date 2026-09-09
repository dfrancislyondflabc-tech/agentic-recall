// scripts/check-docs-install.mjs — DO THE README'S OWN INSTRUCTIONS ACTUALLY WORK TODAY?
//
// 🟥 WHY THIS EXISTS. On 2026-09-08 the README was rewritten to lead with `npx -y agentic-recall`
// in the same commit that made the package publishable — but the package was not published. For
// several hours the FIRST command in the README returned:
//
//     npm error 404  'agentic-recall@*' is not in this registry.
//
// The tarball had been tested hard: npm pack, npm install of that tarball into a clean HOME, and a
// real MCP session over stdio. All of it passed. None of it was the thing a stranger types. The
// documentation described a world that did not exist yet, and every test asked about the artefact
// instead of the instructions.
//
// So this checks the DOCS AGAINST THE WORLD: every install command the README gives must be one a
// stranger could run right now. It needs the network, which is why it is a release gate and not a
// unit test — but it is the gate that would have caught the 404 before it was pushed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

const failures = [];
const notes = [];

async function head(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow' });
    return r.status;
  } catch (e) {
    return `network error: ${e.message}`;
  }
}

// ---- 1. every npm package the README tells you to fetch must exist on npm -------------------
// Matched from COMMANDS and from client config blocks ("command": "npx"), because the config
// block is the copy-paste people actually use and it is where the 404 lived.
//
// 🟥 ONLY INSIDE FENCED CODE BLOCKS. The first cut scanned the whole README and matched the words
// "npm's npx cache is disposable" in a prose paragraph — then checked npm for a package called
// `cache`, which exists, and reported a clean PASS. A gate that passes on prose is worse than no
// gate: it was green at the exact moment the README's real instruction was returning a 404.
const CODE = [...README.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');

const pkgs = new Set();
for (const m of CODE.matchAll(/npx\s+(?:-y\s+)?(@?[a-z0-9][\w.\-/]*)/gi)) pkgs.add(m[1]);
for (const m of CODE.matchAll(/npm\s+(?:i|install)\s+-g\s+(@?[a-z0-9][\w.\-/]*)/gi)) pkgs.add(m[1]);
// "command": "npx", "args": ["-y", "<pkg>"]
for (const m of CODE.matchAll(/"command"\s*:\s*"npx"[\s\S]{0,120}?"args"\s*:\s*\[([^\]]*)\]/g)) {
  for (const a of m[1].matchAll(/"([^"]+)"/g)) if (a[1] !== '-y') { pkgs.add(a[1]); break; }
}

for (const pkg of pkgs) {
  const status = await head(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (status === 200) notes.push(`npm package ${pkg} — published, install instruction is live`);
  else failures.push(
    `README tells a reader to install "${pkg}" from npm, but the registry answers ${status}.\n` +
    `      Either publish it, or stop advertising it until you do.`);
}

// ---- 2. every git clone URL must be reachable BY A STRANGER --------------------------------
// Not merely "a repo of that name exists": a private repo answers 404 to the public, which is
// exactly how the rename to agentic-recall left a dead clone URL in the install section.
for (const m of CODE.matchAll(/git clone\s+(https:\/\/\S+?)(?:\.git)?(?:\s|$)/g)) {
  const url = m[1].replace(/\.git$/, '');
  const status = await head(url);
  if (status === 200) notes.push(`clone URL ${url} — reachable`);
  else failures.push(`README says \`git clone ${url}\` but it answers ${status} to an anonymous reader.`);
}

// ---- 3. a config block naming a local file must not be the ONLY instruction if we also claim
// the package is on npm, and vice versa. Contradictory install stories are how a reader ends up
// running the one that does not work.
const claimsNpx = /"command"\s*:\s*"npx"/.test(CODE);
const claimsNotOnNpm = /not on npm yet/i.test(README);
if (claimsNpx && claimsNotOnNpm) {
  failures.push('README both offers an `npx` config block AND says the package is not on npm.');
}

// ---- report --------------------------------------------------------------------------------
console.log(`docs install check: ${pkgs.size} npm reference(s), README ${README.length} bytes`);
for (const n of notes) console.log(`  ok    ${n}`);
if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n${failures.length} broken install instruction(s). A reader following the README today would hit these.`);
  process.exit(3);
}
console.log('clean — every install instruction in the README works today.');
