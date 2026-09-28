// test/public/commits-survive-rewrite.mjs — A CAPTURE THAT CANNOT SEE THE REPOS MUST NOT UNDO ONE THAT COULD (MEM-99)
//
// Measured 2026-09-28: the connector ran with MEMORY_GIT_REPOS, the 5-minute LaunchAgent and the Stop hook without it. Each capture
// rewrote the same finished exchanges — one adding the "Commits during this exchange" list, the next removing it — on every tick,
// forever: the whole transcript re-read, the files re-embedded, and the rewrites behind a false "vanished" alarm (MEM-100).
//
//   1. a run WITH the repo attaches the commit to the exchange it followed;
//   2. a run WITHOUT the repo leaves that file byte-identical ("unchanged"), commit list and all;
//   3. a run with the repo again changes nothing either — the two kinds of run agree, so nothing can flip-flop.
//   CONTROL: an exchange that never had commits gets none from a run without the repo.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = dirname(dirname(HERE));

const u = (t, ts) => JSON.stringify({ type: 'user', message: { role: 'user', content: t }, timestamp: ts });
const a = (t, ts) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, timestamp: ts });
const long = (w) => (w + ' ').repeat(60).trim();

export async function commitsSurviveRewrite({ check, group }) {
  group('commits survive a capture that cannot see the repos (MEM-99: two capture paths flip-flopped the commit list)');
  const dir = mkdtempSync(join(tmpdir(), 'recall-commits-'));
  try {
    const repo = join(dir, 'repo'), store = join(dir, 'store'), projects = join(dir, '.claude', 'projects', 'proj');
    for (const d of [repo, store, projects, join(dir, 'mem')]) mkdirSync(d, { recursive: true });
    const git = (args, date) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
    git(['init', '-q']);
    writeFileSync(join(repo, 'f.txt'), 'x\n'); git(['add', 'f.txt']);
    const c = git(['commit', '-q', '-m', 'wear limit checker reads twelve speed'], '2026-01-10T10:05:00Z');
    const sha = git(['rev-parse', '--short=7', 'HEAD']).stdout.trim();
    check('fixture: a commit dated between the two exchanges', c.status === 0 && /^[0-9a-f]{7}$/.test(sha), String(c.stderr || '').slice(0, 200));

    const SID = '5c0ffee0-1111-4222-8333-444455556666';
    const tx = join(projects, `${SID}.jsonl`);
    writeFileSync(tx, [
      u('what chain wear limit do we use', '2026-01-10T10:00:00Z'), a(long('Zero point seven five percent stretch on eleven speed'), '2026-01-10T10:00:10Z'),
      u('and for twelve speed', '2026-01-10T12:00:00Z'), a(long('The same checker reads twelve speed chains as well'), '2026-01-10T12:00:10Z'),
    ].join('\n') + '\n');

    const env = (repos) => ({ ...process.env, HOME: dir, USERPROFILE: dir, MEMORY_DIR: join(dir, 'mem'), MEMORY_OWN_STORE: store,
      MEMORY_INDEX: join(dir, 'curated.json'), MEMORY_STAGING_INDEX: join(dir, 'staging.json'), MEMORY_HANDOFF_INDEX: '0',
      MEMORY_PROJECTS_INDEX: '0', MEMORY_LIBRARY: '0', MEMORY_QUERY_LOG: '0', MEMORY_GIT_REPOS: repos });
    const capture = (repos) => spawnSync(process.execPath, [join(TREE, 'scripts', 'ingest-transcript.js'), tx, '--write'],
      { encoding: 'utf8', cwd: TREE, env: env(repos), windowsHide: true });
    const files = () => (existsSync(store) ? readdirSync(store).filter((f) => f.endsWith('.md')).sort() : []);
    const snap = () => Object.fromEntries(files().map((f) => [f, readFileSync(join(store, f), 'utf8')]));

    const r1 = capture(repo);
    const s1 = snap();
    const withCommit = Object.entries(s1).filter(([, t]) => t.includes('**Commits during this exchange:**') && t.includes(sha));
    check('1. with the repo: the commit is attached to the exchange it followed (one file)', r1.status === 0 && withCommit.length === 1,
      `${files().length} files; ${String(r1.stdout).split('\n').find((l) => /^commits/.test(l)) || ''} ${String(r1.stderr || '').slice(0, 200)}`);

    const r2 = capture('');
    const s2 = snap();
    check('2. WITHOUT the repo: nothing is rewritten ("wrote 0")', /\bwrote 0, unchanged 2\b/.test(r2.stdout), String(r2.stdout).split('\n').find((l) => /^wrote/.test(l)) || r2.stdout.slice(-200));
    check('   …and every file is byte-identical, commit list included', JSON.stringify(s2) === JSON.stringify(s1));

    const r3 = capture(repo);
    check('3. with the repo again: still nothing to write — the two kinds of run agree', /\bwrote 0, unchanged 2\b/.test(r3.stdout) && JSON.stringify(snap()) === JSON.stringify(s1),
      String(r3.stdout).split('\n').find((l) => /^wrote/.test(l)) || '');

    const other = Object.entries(s1).filter(([, t]) => !t.includes('**Commits during this exchange:**'));
    check('CONTROL: the exchange that never had commits still has none after a run without the repo',
      other.length === 1 && !snap()[other[0][0]].includes('Commits during'));
  } finally {
    cleanupSandbox(dir);
  }
}
