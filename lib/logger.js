// lib/logger.js — stderr-only logging
// CRITICAL: Never use console.log() in an MCP stdio server.
// stdout is reserved for JSON-RPC protocol messages.
// Any stray stdout output will corrupt the protocol and crash Claude Desktop.

const TAG = 'MEMORY-MCP';

export function log(...args) {
  console.error(`[${TAG} ${new Date().toISOString()}]`, ...args);
}

export function warn(...args) {
  console.error(`[${TAG} WARN ${new Date().toISOString()}]`, ...args);
}

export function error(...args) {
  console.error(`[${TAG} ERROR ${new Date().toISOString()}]`, ...args);
}
