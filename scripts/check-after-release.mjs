#!/usr/bin/env node
// scripts/check-after-release.mjs — the last step of a release: say "released" only when it is TRUE.
//
//   npm run check:after-release [-- <version>]     (default: the version in package.json)
//   AFTER_RELEASE_WAIT_SEC=1800 (default) — how long to wait for the release's workflow runs
//
// 🟥 WHY (MEM-108, 2026-10-09). `check:release` runs BEFORE the release exists, so its ci-green gate
// reads the PREVIOUS release's "published artefact" run. Nothing looked again afterwards, and 2.1.5's
// own run failed unseen for two days (it raced the registry — see scripts/wait-for-registry.mjs).
// Worse, one of its jobs had passed on the WRONG release ("server handshake: agentic-recall 2.1.4").
// This command closes both: it waits for the release's own runs and refuses a green that ran
// other code. Every check below must hold; any one failing prints NOT RELEASED and exits 1.
//
// Maintainer tool: needs `git`, `gh` (authenticated) and network. Not part of `npm test`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SERVER = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
const V = process.argv[2] || PKG.version;
const TAG = `v${V}`;
const WAIT_SEC = Number(process.env.AFTER_RELEASE_WAIT_SEC ?? 1800);

let failures = 0;
const ok = (s) => console.log(`  ok    ${s}`);
const bad = (s) => { failures++; console.log(`  🟥    ${s}`); };
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

console.log(`after-release check: ${PKG.name}@${V}`);

// 1. npm serves it, and `latest` points at it.
try {
  const served = sh('npm', ['view', `${PKG.name}@${V}`, 'version', '--prefer-online']);
  const latest = sh('npm', ['view', PKG.name, 'dist-tags.latest', '--prefer-online']);
  served === V ? ok(`npm serves ${V}`) : bad(`npm does not serve ${V} (got ${JSON.stringify(served)})`);
  latest === V ? ok(`npm latest = ${V}`) : bad(`npm latest is ${latest}, not ${V}`);
} catch (e) { bad(`npm view failed: ${String(e.message).split('\n')[0]}`); }

// 2. the tag and the GitHub release exist, and the tag is the commit npm says it was built from.
let tagSha = null;
try {
  sh('git', ['fetch', '-q', '--tags', 'origin']);
  tagSha = sh('git', ['rev-list', '-n', '1', TAG]);
  ok(`tag ${TAG} = ${tagSha.slice(0, 7)}`);
  const gitHead = sh('npm', ['view', `${PKG.name}@${V}`, 'gitHead']);
  gitHead === tagSha ? ok('npm gitHead = the tag') : bad(`npm gitHead ${gitHead.slice(0, 7)} ≠ tag ${tagSha.slice(0, 7)}`);
} catch (e) { bad(`tag ${TAG} not found: ${String(e.message).split('\n')[0]}`); }
try {
  const rel = JSON.parse(sh('gh', ['release', 'view', TAG, '--json', 'tagName,isDraft,isPrerelease']));
  rel.isDraft ? bad(`GitHub release ${TAG} is still a DRAFT`) : ok(`GitHub release ${TAG} published`);
} catch { bad(`no GitHub release ${TAG}`); }

// 3. CI and the release's own "published artefact" run on that commit — waited for, then read.
async function runFor(workflow) {
  const t0 = Date.now();
  for (;;) {
    let runs = [];
    try {
      runs = JSON.parse(sh('gh', ['run', 'list', '--workflow', workflow, '--limit', '30',
        '--json', 'databaseId,headSha,status,conclusion,createdAt,attempt']))
        .filter((r) => tagSha && r.headSha === tagSha);
    } catch (e) { bad(`gh run list ${workflow} failed: ${String(e.message).split('\n')[0]}`); return null; }
    const run = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (run && run.status === 'completed') return run;
    if ((Date.now() - t0) / 1000 >= WAIT_SEC) {
      bad(`${workflow}: ${run ? `still ${run.status}` : 'no run'} for ${tagSha?.slice(0, 7)} after ${WAIT_SEC}s`);
      return null;
    }
    console.log(`  …     ${workflow}: ${run ? run.status : 'not started'} — waiting`);
    await sleep(30);
  }
}
if (tagSha) {
  const ci = await runFor('ci.yml');
  if (ci) ci.conclusion === 'success' ? ok(`CI green on ${tagSha.slice(0, 7)} (run ${ci.databaseId})`)
    : bad(`CI ${ci.conclusion} on ${tagSha.slice(0, 7)} (run ${ci.databaseId})`);
  const pub = await runFor('published.yml');
  if (pub) {
    pub.conclusion === 'success' ? ok(`published artefact green (run ${pub.databaseId}, attempt ${pub.attempt})`)
      : bad(`published artefact ${pub.conclusion} (run ${pub.databaseId}, attempt ${pub.attempt})`);
    // A green that ran OTHER code is not a green: every server handshake in the logs must be V.
    try {
      const log = sh('gh', ['run', 'view', String(pub.databaseId), '--log']);
      const seen = [...log.matchAll(/server handshake: agentic-recall (\S+)/g)].map((m) => m[1]);
      const wrong = seen.filter((x) => x !== V);
      if (!seen.length) bad('published artefact: no "server handshake" line in the logs — cannot tell which release ran');
      else if (wrong.length) bad(`published artefact ran the WRONG release: handshakes ${[...new Set(seen)].join(', ')}`);
      else ok(`published artefact ran ${V} (${seen.length} handshake(s))`);
    } catch (e) { bad(`could not read the published-artefact log: ${String(e.message).split('\n')[0]}`); }
  }
}

// 4. the MCP registry lists it as latest.
try {
  const name = SERVER.name;
  // Three tries: one "fetch failed" blip made the first run of this script report a false NOT RELEASED.
  let body = null, lastErr = null;
  for (let i = 0; i < 3 && !body; i++) {
    try { const res = await fetch(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`); body = await res.json(); }
    catch (e) { lastErr = e; await sleep(5 * (i + 1)); }
  }
  if (!body) throw new Error(`could not CHECK (3 tries, last: ${lastErr?.message}) — not the same as not listed; re-run`);
  const latest = (body.servers || []).find((s) => (s.server || s).name === name &&
    s._meta?.['io.modelcontextprotocol.registry/official']?.isLatest);
  const lv = latest && (latest.server || latest).version;
  lv === V ? ok(`MCP registry latest = ${V}`) : bad(`MCP registry latest is ${lv ?? 'none'}, not ${V} (run ~/bin/mcp-publisher publish)`);
} catch (e) { bad(`MCP registry check failed: ${e.message}`); }

console.log(failures ? `\nNOT RELEASED — ${failures} check(s) failed.` : `\nRELEASED ${V} — every check green.`);
process.exit(failures ? 1 : 0);
