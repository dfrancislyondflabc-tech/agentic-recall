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
