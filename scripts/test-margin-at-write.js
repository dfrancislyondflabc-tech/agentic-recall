#!/usr/bin/env node
// test-margin-at-write.js — the Stop hook reports a margin regression at the moment
// it is CAUSED, and can never be the reason a turn fails.
// See test/margin-at-write-preregistration.md
//
// The controls here matter more than the feature. Twice on 2026-08-28 a correct
// memory write displaced a gold answer; both memories were KEPT and the displacing
// document was reworded instead. So this must warn and never block — and above all
// it must exit 0 on every path, because commit-memories.js's standing contract is
// that a hook is never the reason a turn fails.
//
// Everything runs against a sandbox memory dir. sandbox-env.js owns the redirect
// list precisely so a new sidecar cannot be forgotten (D2/D3).
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSyncHidden } from '../lib/child.js';   // MEM-83: no console window on Windows
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'commit-memories.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const git = (dir, args) => execFileSyncHidden('git', ['-C', dir, ...args], { encoding: 'utf8' });

/** Run the hook. Returns {code, out} and NEVER throws — that is the thing under test. */
function runHook(dir, env = {}, args = []) {
  try {
    const out = execFileSyncHidden('node', [HOOK, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MEMORY_DIR: dir, MEMORY_MARGIN_HISTORY: join(dir, '..', 'margins.jsonl'), ...env }
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 'threw' : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const mem = (n, d, body) => `---\nname: ${n}\ndescription: "${d}"\n---\n\n${body}\n`;

const tmp = mkdtempSync(join(tmpdir(), 'margin-write-'));
const dir = join(tmp, 'memory');
mkdirSync(dir, { recursive: true });
git(dir, ['init', '-q']);
git(dir, ['config', 'user.email', 't@t']);
git(dir, ['config', 'user.name', 'test']);
writeFileSync(join(dir, 'seed.md'), mem('seed', 'a seed memory', 'seed body words'));
git(dir, ['add', '-A']);
git(dir, ['commit', '-q', '-m', 'seed']);

// ---- CONTROL 1: nothing changed -> exit 0, no warning ----------------------
let r = runHook(dir, { MEMORY_VERBOSE: '1' }, ['--verbose']);
check('CONTROL: clean tree exits 0', r.code === 0, `code=${r.code} out=${r.out.slice(0, 160)}`);
check('CONTROL: clean tree prints no margin warning', !/MARGIN FELL/.test(r.out), r.out.slice(0, 160));

// ---- CONTROL 2: --status is unchanged and exits 0 --------------------------
writeFileSync(join(dir, 'new-one.md'), mem('new-one', 'another memory', 'more body words here'));
r = runHook(dir, {}, ['--status']);
check('CONTROL: --status exits 0', r.code === 0, `code=${r.code}`);
check('CONTROL: --status reports the change and does NOT commit',
  /uncommitted change/.test(r.out) && git(dir, ['status', '--porcelain']).includes('new-one.md'),
  r.out.slice(0, 160));

// ---- CONTROL 3: a real write commits, and exits 0 even though the margin
//                 measurement cannot possibly work in this tiny sandbox ------
// This is the load-bearing control: measureMargins() searches for gold cases that
// do not exist here, so it returns a sentinel or throws. Either way the hook must
// commit the memory and exit 0. A hook that dies here loses a memory.
r = runHook(dir, {}, ['--verbose']);
check('MUST: a real write exits 0 even when margins cannot be measured',
  r.code === 0, `code=${r.code} out=${r.out.slice(0, 300)}`);
check('MUST: the memory was still committed (check runs AFTER the commit)',
  git(dir, ['status', '--porcelain']).trim() === '' &&
  git(dir, ['log', '--oneline']).includes('new-one.md'),
  git(dir, ['log', '--oneline']).split('\n')[0]);
check('MUST: it says why it skipped rather than failing silently',
  /margin check/.test(r.out), r.out.slice(0, 300));

// ---- CONTROL 4: a THROWING margin module still exits 0 ---------------------
// Simulated by pointing the history sidecar at an unwritable path and giving the
// corpus no index at all; the import or the measurement may throw. Must not matter.
writeFileSync(join(dir, 'third.md'), mem('third', 'a third memory', 'third body words'));
r = runHook(dir, { MEMORY_MARGIN_HISTORY: '/nonexistent-dir-xyz/margins.jsonl', MEMORY_INDEX: '/nonexistent-dir-xyz/i.json' }, ['--verbose']);
check('MUST: an unwritable history + missing index still exits 0', r.code === 0,
  `code=${r.code} out=${r.out.slice(0, 300)}`);
check('MUST: that write was committed too',
  git(dir, ['status', '--porcelain']).trim() === '',
  git(dir, ['status', '--porcelain']));

// ---- CONTROL 5: the warning text itself is well-formed ---------------------
// Unit-level: trendLine/report wording is exercised without needing a real corpus.
const src = readFileSync(HOOK, 'utf8');
check('MUST: the report names the displacing document', /displaced by/.test(src));
check('MUST: the report says it is not blocking', /NOT BLOCKED/.test(src));
check('MUST: it directs the fix to the corpus, not the ranker',
  /in the CORPUS/.test(src) && /never in the ranker/.test(src));
check('MUST: every margin path is wrapped so the hook cannot fail',
  /catch \(e\) \{[\s\S]{0,200}margin check skipped/.test(src));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
