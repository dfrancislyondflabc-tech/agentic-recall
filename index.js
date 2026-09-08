#!/usr/bin/env node

// agentic-recall — two-tier hybrid retrieval over Claude's persistent memory.
//
// IMPORTANT: Use console.error() for logging, NOT console.log().
// stdout is reserved for JSON-RPC protocol messages. Any stray stdout output
// will corrupt the protocol and crash Claude Desktop.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log, error } from './lib/logger.js';
import { registerMemoryTools } from './tools/memory.js';
import { memoryDir, indexPath, configWarning } from './lib/config.js';
import { versionBanner, serverVersionString, serverVersion } from './lib/version.js';
import { startHeartbeat } from './lib/heartbeat.js';
import { startScheduler } from './lib/scheduler.js';

// ---- CLI FLAGS, BEFORE ANYTHING ELSE -------------------------------------------------------
// This ships as a `bin`, so `npx -y agentic-recall --version` is the first thing a person runs to
// check the install worked. Before 1.8.0 an unknown argument was ignored: the process started a
// full MCP server on a closed stdin and exited 0, which looks exactly like success and tells the
// caller nothing. Handled here, ahead of every import side effect, so no scheduler starts and no
// state directory is created just to answer a question about the version.
//
// stdout is the JSON-RPC channel for the SERVER; these paths never start one, so printing to
// stdout here is correct — a caller piping `--version` wants it on stdout, not stderr.
// One version string for both flags: the commit is the useful half in a checkout, and there is
// no commit in a package install — where "1.8.0@unknown-sha(no-git)" reads as a failed install.
const displayVersion = () => {
  const v = serverVersion();
  return v.source === 'git' ? serverVersionString() : v.packageVersion;
};

{
  const argv = process.argv.slice(2);
  const has = (...f) => argv.some((a) => f.includes(a));
  if (has('-v', '--version')) {
    // In a CHECKOUT the commit is the useful half — two installs can both say 1.8.0 and differ.
    // In a PACKAGE install there is no git, and the honest string for that is "1.8.0@unknown-sha
    // (no-git)", which reads to a new user as something having gone wrong on their first command.
    // So: the full string when there is a commit to name, the plain version when there is not.
    console.log(displayVersion());
    process.exit(0);
  }
  if (has('-h', '--help')) {
    console.log([
      `agentic-recall ${displayVersion()} — long-term memory for agentic tasks.`,
      '',
      'It is an MCP server: it speaks JSON-RPC over stdin/stdout and is meant to be',
      'launched by a client, not run by hand. Add it to your Claude config as:',
      '',
      '  "memory": { "command": "npx", "args": ["-y", "agentic-recall"],',
      '              "env": { "MEMORY_DIR": "/path/to/your/memory/folder" } }',
      '',
      'Flags:',
      '  -v, --version   print the version and exit',
      '  -h, --help      print this and exit',
      '',
      'Key environment variables:',
      '  MEMORY_DIR      the folder holding your memories. Required; never guessed.',
      '  MEMORY_ROOT     where the model cache, vector cache and indexes live.',
      '                  Defaults beside the code for a clone, ~/.agentic-recall for',
      '                  a package install.',
      '',
      'Docs: https://github.com/dfrancislyondflabc-tech/agentic-recall#readme'
    ].join('\n'));
    process.exit(0);
  }
  const unknown = argv.filter((a) => a.startsWith('-'));
  if (unknown.length) {
    // Refuse rather than ignore. A silently-dropped flag is how a person concludes an option
    // exists when it does not.
    console.error(`agentic-recall: unknown option ${unknown[0]}. Try --help.`);
    process.exit(2);
  }
}

// ---- Graceful signal handling ----
// Prevents a Claude Desktop crash on disconnect or kill.
process.on('SIGPIPE', () => { /* ignore — the client closed the pipe */ });
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  error('Uncaught exception:', err.message);
  // DON'T exit — let the MCP SDK handle recovery.
});
process.on('unhandledRejection', (reason) => {
  error('Unhandled rejection:', reason);
  // DON'T exit — let the MCP SDK handle recovery.
});

// The version the client is told at `initialize`. It was hardcoded '1.1.0' while
// package.json said 1.6.3 — five releases of drift in the one field a client
// reads before it can read anything else. serverVersion() already parses
// package.json (lib/version.js:93-96) for the banner and the response stamp; the
// handshake now reads the same field, so there is one version, not two.
const server = new McpServer({
  name: 'agentic-recall',
  version: serverVersion().packageVersion || '0.0.0'
});

registerMemoryTools(server);

async function main() {
  // WHICH BUILD IS ANSWERING — logged before the transport, so it is the first
  // line in the log even if the connect fails. Node caches every module at
  // spawn, so a client that was launched this morning is still running this
  // morning's code; without this line that is invisible, and on 2026-08-19 it
  // cost a session an afternoon. stderr only: stdout is the JSON-RPC channel.
  // THE CONNECTOR TOGGLE IS THE CAPTURE SWITCH. While this process lives, it leaves a dated
  // mark that scripts/auto-ingest.js reads — so turning the connector off in Claude's UI stops
  // capture, with nothing else to configure. See lib/heartbeat.js.
  startHeartbeat();
  // AND THE SERVER KEEPS TIME. Capture used to depend on a macOS LaunchAgent that Windows does not
  // have and a Stop hook that only ever reaches the session that just ended, so a chat left open
  // all afternoon was captured never. While this process lives it spawns the existing walker every
  // five minutes -- it writes nothing itself; see the header of lib/scheduler.js. Off with
  // MEMORY_SCHEDULER=0.
  startScheduler({ log: (m) => log(m) });
  log(versionBanner());
  // 🟥 MEM-68/U-4 — ONE LINE, AT BOOT, WHEN THE CONFIG IS THE 1.7.0 ONE. An install upgraded in
  // place keeps the config the OLD setup page generated: MEMORY_DIR without MEMORY_LIBRARY_DIR,
  // which is the MEM-32 trap the new setup page exists to close. Nothing re-runs setup and, until
  // now, nothing said so — a `scope:'everything'` search just omitted every library category. The
  // same fact is stamped as `configWarning` on responses (lib/search.js); this is the half a
  // support session reads. Silent when the config is right.
  const cw = configWarning();
  if (cw) log(`CONFIG: ${cw.why} — ${cw.effect}. Fix: ${cw.fix}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Connected — ${serverVersionString()} (1 tool: memory). corpus=${memoryDir()} index=${indexPath()}`);
}

main().catch((e) => {
  error('Fatal:', e);
  process.exit(1);
});
