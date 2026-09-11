// test/public/doctor.mjs — `--doctor` must ANSWER, and every warning it can print must be
// reachable. A diagnostic that always says "ok" is worse than none: it converts an unknown into a
// false reassurance, which is exactly how three problems stayed live on one machine for days.
//
// 🟥 SO EVERY CHECK HERE HAS A FIRING CASE. The rule the author broke repeatedly the week this was
// written: a negative result ("no drift", "nothing missing") is only evidence if the probe has been
// shown to detect the positive. Each block below builds the broken configuration first.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanupSandbox } from './sandbox-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(dirname(dirname(HERE)));

export async function doctorTests({ check, group }) {
  group('(dr) --doctor — what does this configuration actually resolve to?');
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ar-doctor-')));
  const mem = join(tmp, 'mem'), home = join(tmp, 'home');
  mkdirSync(mem, { recursive: true });
  mkdirSync(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
  writeFileSync(join(mem, 'n.md'), '---\nname: n\ndescription: d\n---\nbody\n');

  const run = (env) => spawnSync(process.execPath, [join(REPO, 'index.js'), '--doctor'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMORY_DIR: mem, MEMORY_ROOT: join(tmp, 'state'),
      MEMORY_STAGING_INDEX: '0', MEMORY_PROJECTS_INDEX: '0', MEMORY_HANDOFF_INDEX: '0',
      MEMORY_LIBRARY: '0', MEMORY_SCHEDULER: '0', ...env }
  });

  try {
    const base = run({});
    check('(dr1) --doctor exits 0', base.status === 0, `exit ${base.status} :: ${String(base.stderr).slice(0, 120)}`);
    check('(dr1) ...and reports the corpus it would read', base.stdout.includes(mem), 'memory folder not named');
    check('(dr1) ...and says plainly that it changed nothing',
      /never writes/i.test(base.stdout), 'no read-only statement');
    check('(dr1) [control] it did NOT start a server — no scheduler banner',
      !/capture scheduler ON/.test(String(base.stderr)), 'a server started');

    // ---- config drift: the mistake this section exists for -------------------------------------
    const desktop = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const cli = join(home, '.claude.json');
    writeFileSync(desktop, JSON.stringify({ mcpServers: { memory: { command: 'npx', args: ['-y', 'agentic-recall@2'], env: { MEMORY_DIR: mem } } } }));
    writeFileSync(cli, JSON.stringify({ mcpServers: { memory: { command: 'npx', args: ['-y', 'agentic-recall@2'], env: { MEMORY_DIR: mem } } } }));
    const agree = run({});
    check('(dr2) two IDENTICAL definitions report agreement', /all definitions agree/.test(agree.stdout), '');

    // 🟥 THE FIRING CASE. Without this the line above proves nothing.
    writeFileSync(cli, JSON.stringify({ mcpServers: { memory: { command: 'node', args: ['/old/path/memory-mcp-server/index.js'], env: {} } } }));
    const drift = run({});
    check('(dr2) 🟥 two DISAGREEING definitions are reported — the exact "I edited the wrong file" case',
      /DEFINITIONS DISAGREE/.test(drift.stdout), 'drift not detected');
    check('(dr2) ...and it names both, so you can see which one the client is running',
      /agentic-recall@2/.test(drift.stdout) && /old\/path/.test(drift.stdout), 'both definitions not shown');

    // ---- a suppressed corpus must be named, with the variable that did it ----------------------
    const supp = run({ MEMORY_HANDOFF_INDEX: join(tmp, 'h.json'), MEMORY_HANDOFF_DIRS: '' });
    check('(dr3) 🟥 a corpus that is NOT SEARCHED says so, and names the variable',
      /handoff\s+NOT SEARCHED/.test(supp.stdout) && /MEMORY_HANDOFF_DIRS/.test(supp.stdout), '');
    const reach = run({ MEMORY_HANDOFF_INDEX: join(tmp, 'h.json'), MEMORY_HANDOFF_DIRS: tmp });
    check('(dr3) [control] a reachable corpus is NOT reported as suppressed',
      !/handoff\s+NOT SEARCHED/.test(reach.stdout), 'reported a reachable corpus as suppressed');

    // ---- a runtime file the code opens, missing -------------------------------------------------
    const miss = run({ MEMORY_SECRETS_CONFIG: join(tmp, 'nope.json') });
    check('(dr4) 🟥 a MISSING runtime file is reported — the capture-breaking case',
      /^.*secrets-exclude.*MISSING.*$/m.test(miss.stdout), '');
    check('(dr4) [control] a present one is not reported as missing',
      !/^.*secrets-exclude.*MISSING.*$/m.test(base.stdout), 'false MISSING on a good install');

    check('(dr4) [control] files CREATED ON DEMAND are not screamed about on a fresh install',
      !/🟥.*(model cache|capture store|query log)/.test(base.stdout),
      'a healthy fresh install was flagged — a diagnostic that cries wolf gets ignored');
    check('(dr5) the version section names the running build', /running:/.test(base.stdout), '');
  } finally {
    cleanupSandbox(tmp, { label: 'doctor' });
  }
}
