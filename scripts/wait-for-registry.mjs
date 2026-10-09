#!/usr/bin/env node
// scripts/wait-for-registry.mjs — wait until npm SERVES an exact version, then name it.
//
//   node scripts/wait-for-registry.mjs [version]     (default: the version in package.json)
//   WAIT_SEC=600 (default) · POLL_SEC=15 (default)
//
// 🟥 WHY (MEM-108, 2026-10-09). The "published artefact" workflow starts when the GitHub release is
// created — about a minute after `npm publish` returned, which is BEFORE the registry serves the new
// version. For 2.1.5 that race did both bad things at once:
//
//   * `published` asked for agentic-recall@2.1.5 exactly and FAILED (ETARGET, "No matching version")
//     on a release that was fine;
//   * `real-book` asked for agentic-recall@2, got the PREVIOUS release, printed
//     "server handshake: agentic-recall 2.1.4" — and reported SUCCESS. Green, on the wrong code.
//
// So both jobs now wait here first, and are handed the exact version this script saw served. On a
// GitHub runner it writes `version=<v>` to $GITHUB_OUTPUT. Exit 2 when the deadline passes: a version
// npm still does not serve after ten minutes is a real problem, not a race.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';
const NPMOPT = WIN ? { shell: true } : {};   // see scripts/check-published.mjs for why

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const WANT = process.argv[2] || PKG.version;
const WAIT_SEC = Number(process.env.WAIT_SEC ?? 600);
const POLL_SEC = Number(process.env.POLL_SEC ?? 15);

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(WANT)) {
  console.log(`🟥 not an exact version: ${JSON.stringify(WANT)}`);
  process.exit(2);
}

function served() {
  try {
    const out = execFileSync(NPM, ['view', `${PKG.name}@${WANT}`, 'version', '--prefer-online'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...NPMOPT }).trim();
    return out.split(/\s+/).pop() === WANT;
  } catch { return false; }
}

const t0 = Date.now();
let tries = 0;
for (;;) {
  tries++;
  if (served()) {
    const s = Math.round((Date.now() - t0) / 1000);
    console.log(`registry serves ${PKG.name}@${WANT}${tries > 1 ? ` (after ${s}s, ${tries} tries)` : ''}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${WANT}\n`);
    process.exit(0);
  }
  if ((Date.now() - t0) / 1000 >= WAIT_SEC) {
    console.log(`🟥 the registry still does not serve ${PKG.name}@${WANT} after ${WAIT_SEC}s — not a race any more`);
    process.exit(2);
  }
  console.log(`  not served yet: ${PKG.name}@${WANT} — retrying in ${POLL_SEC}s`);
  await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
}
