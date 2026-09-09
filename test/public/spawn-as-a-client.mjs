// test/public/spawn-as-a-client.mjs — CAN A NODE MCP CLIENT ACTUALLY SPAWN THE DOCUMENTED CONFIG?
//
// 🟥 THE FAILURE THIS EXISTS FOR, reported from a real Windows 11 machine (2026-09-09).
//
// On Windows `npx` is a batch shim (npx.cmd). Node's child_process.spawn only resolves .cmd via
// PATHEXT when `shell: true` is set. So a Node-based MCP client that spawns the config this
// project's README recommends —
//
//     "command": "npx", "args": ["-y", "agentic-recall"]
//
// — gets `spawn EINVAL` (or ENOENT) and the server NEVER CONNECTS. The symptom is the worst kind
// for adoption: the server appears configured, shows in the client's list, and silently does
// nothing. There is no error the user sees and nothing to search for.
//
// This is not specific to this package — it is the standard Windows MCP gotcha, with an open
// issue against Claude Code itself (anthropics/claude-code#58510). `npm i -g` is NOT an escape:
// that installs a .cmd shim too. The only shim-free form is pointing `node` at the .js file.
//
// WHAT THIS PROVES, and it is deliberately the user's path and not a convenient one: it spawns
// the PUBLISHED package the way a Node client does — no shell — and completes a real `initialize`
// handshake over stdio. Run on windows-latest in CI, it turns the README's Windows advice from
// something read on the internet into something measured on every push.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stopChild } from './sandbox-cleanup.mjs';

const isWindows = process.platform === 'win32';

// 🟥 THE CWD DECIDES WHICH PACKAGE THIS TESTS, and getting it wrong makes the whole probe a lie.
// `npx -y agentic-recall` run from INSIDE this repository resolves to the LOCAL checkout, not the
// registry: measured, it reported 1.8.2@3a08b9a from the repo and 1.8.1 from a neutral directory,
// while npm was serving 1.8.1. A probe whose entire purpose is "does the PUBLISHED package spawn"
// silently answered a different question. Run it from a neutral cwd; this refuses otherwise.
function assertNeutralCwd() {
  const pkg = join(process.cwd(), 'package.json');
  if (existsSync(pkg)) {
    try {
      if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'agentic-recall') {
        return 'cwd is the agentic-recall checkout — npx would resolve the LOCAL code, not the '
             + 'published package. Run this from a neutral directory.';
      }
    } catch { /* unreadable package.json is not this check's business */ }
  }
  return null;
}

/** The two forms the README documents. On POSIX they are the same command. */
const FORMS = isWindows
  ? [
      { name: 'cmd /c npx  (the documented Windows form)', cmd: 'cmd', args: ['/c', 'npx', '-y', 'agentic-recall'] },
      { name: 'bare npx    (the form that fails on Windows)', cmd: 'npx', args: ['-y', 'agentic-recall'], expectFail: true }
    ]
  : [
      { name: 'npx         (POSIX: no shim, spawns directly)', cmd: 'npx', args: ['-y', 'agentic-recall'] }
    ];

function handshake({ cmd, args }, memoryDir) {
  return new Promise((resolve) => {
    let child;
    try {
      // NO shell: true. That is the whole point — a client that sets it does not have this
      // problem, and one that does not is the case being tested.
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MEMORY_DIR: memoryDir } });
    } catch (e) {
      return resolve({ spawned: false, error: `${e.code || ''} ${e.message}`.trim() });
    }
    child.on('error', (e) => resolve({ spawned: false, error: `${e.code || ''} ${e.message}`.trim() }));

    let buf = '';
    let done = false;
    // stopChild, not a bare kill(): npx spawns a CHILD of its own, so killing the shim can leave
    // the real server orphaned — on Windows especially, where it then holds the model cache open.
    // The shared helper kills the tree and waits. The suite's own hygiene gate enforces this, and
    // it caught this file on the first run.
    const finish = (r) => {
      if (done) return;
      done = true;
      Promise.resolve(stopChild(child)).catch(() => {}).then(() => resolve(r));
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 1 && m.result && m.result.serverInfo) {
            return finish({ spawned: true, serverInfo: m.result.serverInfo });
          }
        } catch { /* not JSON-RPC; the server logs to stderr, so this is rare */ }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'spawn-probe', version: '1' } }
    }) + '\n');
    setTimeout(() => finish({ spawned: false, error: 'no initialize response within 60s' }), 60000);
  });
}

export async function spawnAsAClientTests({ check, group }, memoryDir) {
  group(`(spawn) a Node client spawning the documented config — ${process.platform}`);
  const wrongCwd = assertNeutralCwd();
  check('(spawn) CONTROL — running from a neutral cwd, so npx resolves the PUBLISHED package',
    wrongCwd === null, wrongCwd || `cwd=${process.cwd()}`);
  if (wrongCwd) return;
  let considered = 0;
  for (const form of FORMS) {
    const r = await handshake(form, memoryDir);
    considered++;
    if (form.expectFail) {
      // NOT asserted as a failure: some Windows/Node combinations resolve the shim fine, and a
      // check that demands a bug be present breaks the day the platform fixes it. Reported only,
      // so the log says which forms worked on this runner.
      console.log(`  note  ${form.name} -> ${r.spawned ? 'spawned (this runner tolerates it)' : 'FAILED: ' + r.error}`);
      continue;
    }
    check(`(spawn) ${form.name}`, r.spawned === true, r.error || '');
    check(`(spawn) ...and it answered initialize with a serverInfo`,
      !!(r.serverInfo && r.serverInfo.name), JSON.stringify(r.serverInfo || {}).slice(0, 90));
  }
  check('(spawn) CONTROL — at least one form was actually attempted',
    considered >= 1, `${considered} form(s)`);
}
