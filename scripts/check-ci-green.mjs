// scripts/check-ci-green.mjs — REFUSE TO SHIP WHILE CI IS RED.
//
// 🟥 WHY THIS EXISTS. Measured 2026-09-15 from the run history of the `published artefact`
// workflow: four runs in its entire life, THREE of them failures, including the run triggered by
// the 2.0.2 RELEASE itself. The gate reported honestly every time. Nobody looked — the failure
// notice went to an inbox with five figures of unread mail — and a session then recorded in the
// project's memory that the gate had run "CLEAN first time". It had never passed at all.
//
// A gate whose red is tolerated is worth exactly as much as no gate. The defect is not the gate,
// it is WHERE THE SIGNAL LANDS: `published artefact` runs on the `release` event, i.e. AFTER the
// thing it guards, so ignoring it costs nothing and preventing anything is impossible.
//
// This puts the signal in the path a human actually walks: `npm run check:release`, the command
// you type before shipping. Red CI now stops you here.
//
// Needs the `gh` CLI, authenticated. If gh is missing it REFUSES rather than passing — an
// unverifiable green is the precise failure this file exists to end.
import { execFileSync } from 'node:child_process';

const REPO = 'dfrancislyondflabc-tech/agentic-recall';
// argv[2] overrides the branch SO THIS GATE CAN BE MUTATION-TESTED. Point it at a branch with
// no runs and it must REFUSE; that is the control proving it is not vacuous.
const BRANCH = process.argv[2] || 'main';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

console.log(`ci check: latest run per workflow on ${BRANCH}`);

let runs;
try {
  const raw = gh(['api', `repos/${REPO}/actions/runs?branch=${BRANCH}&per_page=100`,
                  '--jq', '.workflow_runs[] | [.name, .conclusion, .status, .head_sha[0:8], .created_at, (.id|tostring)] | @tsv']);
  runs = raw.trim().split('\n').filter(Boolean).map((l) => {
    const [name, conclusion, status, sha, created, id] = l.split('\t');
    return { name, conclusion, status, sha, created, id };
  });
} catch (e) {
  console.error('\n  FAIL  could not read CI status from GitHub.');
  console.error(`        ${String(e.message).split('\n')[0]}`);
  console.error('        Refusing rather than assuming green — an unverifiable pass is what this gate exists to prevent.');
  process.exit(3);
}

if (!runs.length) {
  console.error(`\n  FAIL  GitHub reported NO workflow runs on ${BRANCH}. This gate checked nothing.`);
  process.exit(3);
}

// latest run per workflow name
const latest = new Map();
for (const r of runs) if (!latest.has(r.name)) latest.set(r.name, r);

let red = 0;
for (const [name, r] of latest) {
  const verdict = r.status !== 'completed' ? `(${r.status})` : r.conclusion;
  const mark = r.conclusion === 'success' ? 'ok   ' : r.status !== 'completed' ? '..   ' : 'RED  ';
  if (r.status === 'completed' && r.conclusion !== 'success') red++;
  console.log(`  ${mark} ${name.padEnd(24)} ${String(verdict).padEnd(10)} ${r.sha}  run ${r.id}`);
}

if (red) {
  console.error(`\nREFUSED: ${red} workflow(s) are RED on ${BRANCH}.`);
  console.error('Do not ship on top of a failing gate. Either fix it, or delete the gate honestly —');
  console.error('a red nobody acts on is indistinguishable from having no gate at all.');
  process.exit(3);
}
console.log(`clean — all ${latest.size} workflow(s) green on ${BRANCH}.`);
