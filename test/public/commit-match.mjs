// MEM-117 — A COMMIT THAT LANDED DURING A STRETCH OF CONVERSATION IS MATCHED TO IT BY FILE.
//
// `thread` lists the commits that landed while a stretch of conversation was happening (time alone). This adds the
// files each commit changed and whether the stretch NAMES any of them. Proves, against a throwaway git repo: the file
// names are read out of prose (paths reduced to basenames, version numbers and plain words ignored); a commit touching a
// named file is 'touches-discussed-files', one touching only other files is 'other-files', prose naming no file is
// 'no-files-named-here'; an unknown repo/sha is 'unknown' (never a guess); and the whole check never throws.
import { spawnSync } from 'node:child_process';
import { stopChild, cleanupSandbox } from './sandbox-cleanup.mjs';   // repo rule: tests that spawn import the cleanup helper (spawnSync ends its own child)
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
const require_fs = { readdirSync, readFileSync };
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export async function commitMatchTests({ check, group }) {
  group('MEM-117 — commits during a conversation window are matched to it by the files they changed');
  const dir = mkdtempSync(join(tmpdir(), 'mem117-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'lib'), { recursive: true });
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q');
    writeFileSync(join(repo, 'lib', 'bom-lookup.js'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-q', '-m', 'bom lookup');
    const shaA = git('rev-parse', '--short', 'HEAD').stdout.trim();
    writeFileSync(join(repo, 'deck.css'), 'body{}\n'); git('add', '.'); git('commit', '-q', '-m', 'deck style');
    const shaB = git('rev-parse', '--short', 'HEAD').stdout.trim();

    const src = `const G = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'git-join.js')).href)});
      const label = ${JSON.stringify('repo')};
      const named = [...G.mentionedFiles(['I changed lib/bom-lookup.js and README.md; v2.1.5 shipped. Node.js is fine. The server.js.', 'nothing here'])].sort();
      const c = [{ sha: ${JSON.stringify(shaA)}, repo: label }, { sha: ${JSON.stringify(shaB)}, repo: label }];
      const yes = await G.matchCommitsToText(c, ['The fix is in bom-lookup.js — the part number regex.']);
      const none = await G.matchCommitsToText(c, ['We talked about the weather and nothing else.']);
      const unk = await G.matchCommitsToText([{ sha: 'deadbee', repo: 'no-such-repo' }], ['bom-lookup.js']);
      const empty = await G.matchCommitsToText([], ['x']);
      process.stdout.write('@@' + JSON.stringify({ named, yes, none, unk, empty }) + '@@');`;
    const r0 = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', env: { ...process.env, MEMORY_GIT_REPOS: repo }, timeout: 60000 });
    const m = /@@([\s\S]*)@@/.exec(r0.stdout || '');
    const r = m ? JSON.parse(m[1]) : { error: (r0.stderr || '').slice(-300) };

    check('file names are read out of prose as basenames (path dropped; version numbers and words ignored)',
      JSON.stringify(r.named) === JSON.stringify(['bom-lookup.js', 'node.js', 'readme.md', 'server.js']), JSON.stringify(r.named));
    const [a, b] = (r.yes && r.yes.commits) || [];
    check("a commit that changed a file the exchanges name is 'touches-discussed-files', naming the file",
      a && a.match === 'touches-discussed-files' && JSON.stringify(a.discussedFiles) === '["bom-lookup.js"]' && a.files.includes('lib/bom-lookup.js'), JSON.stringify(a));
    check("a commit that changed only other files is 'other-files'", b && b.match === 'other-files' && b.files.includes('deck.css'), JSON.stringify(b));
    check('the summary counts: 1 of 2 matched, 1 file named', r.yes && r.yes.matched === 1 && r.yes.named === 1, JSON.stringify(r.yes && { matched: r.yes.matched, named: r.yes.named }));
    check("exchanges that name no file: 'no-files-named-here' — time stays the only link, nothing is claimed",
      r.none && r.none.commits.every((x) => x.match === 'no-files-named-here') && r.none.matched === 0, JSON.stringify(r.none && r.none.commits.map((x) => x.match)));
    check("an unknown repo or commit is 'unknown', never a guess; an empty list is returned as is",
      r.unk && r.unk.commits[0].match === 'unknown' && r.empty && r.empty.matched === 0 && r.empty.commits.length === 0, JSON.stringify({ unk: r.unk, empty: r.empty }));
  } finally { cleanupSandbox(dir, { label: 'mem117' }); }
}

// MEM-118 — THE COMMITS A SESSION RAN ITSELF, from its own tool calls, decided from git's OUTPUT. Measured on a real
// 460 MB session: 784 commit runs, 732 of them `git commit -q` (prints nothing on success) — so three states, never two.
export async function commitMarkerTests({ check, group }) {
  group('MEM-118 — commit markers from the session\'s own tool calls (landed / did not land / quiet), no commit text kept');
  const M = await import(pathToFileURL(join(ROOT, 'lib', 'commit-markers.js')).href);
  const yes = ['git commit -q -m x', 'cd "/a b/repo" && git add . && git commit -m "y"', 'git -C /x/server commit -qm z', 'if true; then git commit -m a; fi', 'echo hi\ngit commit -am w', 'git commit --amend --no-edit'];
  const no = ['git log --oneline -1', 'git commit --dry-run -m x', "grep 'git commit' notes.md", 'echo "git commit"', 'git commit-tree abc'];
  check('a commit command is recognised wherever it starts a command; a search, an echo, a dry run or commit-tree is not',
    yes.every(M.isCommitCommand) && !no.some(M.isCommitCommand), JSON.stringify({ yes: yes.map(M.isCommitCommand), no: no.map(M.isCommitCommand) }));
  check('the repo is a folder NAME from `cd <dir> &&` or `git -C <dir>`, never a path, never a shell variable',
    M.repoHintOf('cd "/a b/repo" && git commit -m y') === 'repo' && M.repoHintOf('git -C /x/server commit -qm z') === 'server' && M.repoHintOf('cd $SRV && git commit -m a') === null);
  const o = (t, e) => M.commitOutcome(t, e).state;
  check("outcome from git's output: [main sha] or a push of it = landed; error / nothing to commit = not-landed; quiet success = unconfirmed",
    o('[main 3ed5fde] MEM-116: x\n 2 files changed', false) === 'landed' && M.commitOutcome('   56d05de..0fca810  main -> main', false).shas[0] === '0fca810'
    && o('Exit code 1 husky - pre-commit hook failed', true) === 'not-landed' && o('On branch main\nnothing to commit, working tree clean', false) === 'not-landed'
    && o('', false) === 'unconfirmed');

  const c = M.createCommitCollector();
  const asst = (id, cmd, ts, extra = {}) => ({ timestamp: ts, ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } });
  const res = (id, text, isErr) => ({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isErr ? { is_error: true } : {}) }] } });
  for (const r of [asst('a', 'cd /r/server && git commit -m x', '2026-11-25T10:00:00Z'), res('a', '[main abc1234] x', false),
    asst('b', 'git commit -qm y', '2026-11-25T10:05:00Z'), res('b', '', false),
    asst('c', 'git commit -m z', '2026-11-25T10:06:00Z'), res('c', 'nothing to commit', true),
    asst('d', 'git commit -m side', '2026-11-25T10:07:00Z', { isSidechain: true }), res('d', '[main 9999999] side', false),
    asst('e', 'git commit -m pending', '2026-11-25T10:08:00Z'), asst('f', 'git log -1', '2026-11-25T10:09:00Z'), res('f', 'fff0000 x', false)]) c.see(r);
  const mk = c.markers();
  check('the collector: landed + sha + repo, quiet, failed; a subagent\'s commit and a call with no result yet are left out; a plain git log is not a commit',
    mk.length === 3 && mk[0].state === 'landed' && mk[0].shas[0] === 'abc1234' && mk[0].repo === 'server' && mk[1].state === 'unconfirmed' && mk[2].state === 'not-landed', JSON.stringify(mk));
  const b = M.bucketMarkers([{ ts: '2026-11-25T09:59:00Z' }, { ts: '2026-11-25T10:04:00Z' }], mk);
  check('each marker goes to the last exchange already asked when it ran', (b.get(0) || []).length === 1 && (b.get(1) || []).length === 2, JSON.stringify([...b]));

  // end to end through the real extractor: markers in frontmatter + body; a session with no commit is byte-identical
  const dir = mkdtempSync(join(tmpdir(), 'mem118-'));
  try {
    const reply = 'The part number regex in the lookup now accepts the RP suffix, and the price book reader keeps the ' +
      'description column intact. I ran the full suite before committing: everything passed, including the new case for ' +
      'rack-mount models with redundant power supplies, which used to be dropped silently.';
    const tx = (withCommit) => [
      { type: 'user', timestamp: '2026-11-25T10:00:00Z', message: { role: 'user', content: 'Please fix the part number lookup for rack mount models with the RP suffix and commit it.' } },
      ...(withCommit ? [asst('t1', 'cd /r/server && git add . && git commit -m "fix RP suffix"', '2026-11-25T10:01:00Z'), { timestamp: '2026-11-25T10:01:05Z', ...res('t1', '[main 1a2b3c4] fix RP suffix', false) }] : []),
      { type: 'assistant', timestamp: '2026-11-25T10:02:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } }
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';
    const run = (name, body, extraEnv = {}) => {
      const f = join(dir, name + '.jsonl'); writeFileSync(f, body);
      const store = join(dir, 'store-' + name + (extraEnv.MEMORY_CAPTURE_COMMIT_MARKERS || ''));
      mkdirSync(store, { recursive: true });
      spawnSync(process.execPath, [join(ROOT, 'scripts', 'ingest-transcript.js'), f, '--write', '--backfill'],
        { encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir, MEMORY_OWN_STORE: store, MEMORY_GIT_REPOS: '', MEMORY_LOG_LEVEL: 'warn', ...extraEnv }, timeout: 60000 });
      const { readdirSync, readFileSync } = require_fs;
      return readdirSync(store).filter((x) => x.endsWith('.md')).map((x) => readFileSync(join(store, x), 'utf8')).join('\n');
    };
    const withC = run('aaaa1111-0000-0000-0000-000000000001', tx(true));
    check('captured exchange carries `sessionCommits: 1a2b3c4` and a body line naming it as landed in `server` — and no commit message text',
      /sessionCommits: 1a2b3c4/.test(withC) && /`1a2b3c4` landed \(server\)/.test(withC) && !/fix RP suffix/.test(withC), withC.slice(0, 600));
    const plainOn = run('bbbb2222-0000-0000-0000-000000000002', tx(false));
    const plainOff = run('bbbb2222-0000-0000-0000-000000000002', tx(false), { MEMORY_CAPTURE_COMMIT_MARKERS: '0' });
    check('a session that ran no commit is captured byte-identically with markers on and off (control)', plainOn.length > 200 && plainOn === plainOff);
  } finally { cleanupSandbox(dir, { label: 'mem118' }); }
}
