#!/usr/bin/env node
// scripts/store-audit-tick.mjs — one transcript-vs-store audit, spawned by the in-server scheduler.
//
//   node scripts/store-audit-tick.mjs              the 20 most recently touched sessions
//   node scripts/store-audit-tick.mjs --max 5      fewer
//   node scripts/store-audit-tick.mjs --no-heal    report only; change nothing
//   node scripts/store-audit-tick.mjs --snapshot   force today's store snapshot as well
//
// A SCRIPT AND NOT A FUNCTION CALL IN THE SERVER, for the reason lib/scheduler.js exists at all:
// the loaded MCP server schedules and never writes. This runs detached, does its work in its own
// process, appends one row to store/.ingest-runs.jsonl and exits — so a server that is closed
// mid-audit loses an audit and nothing else.
//
// Exit code is 0 unless the tick itself failed to run. An ALARM is not a failure exit: this is a
// background detector, its finding is the log row and captureHealth, and a non-zero exit would put
// a red line in whatever launched it for a condition it has usually just repaired.
import { writeAuditStamp } from '../lib/scheduler.js';
import { runAuditTick } from '../lib/store-audit-tick.js';
import { snapshotStore, snapshotDir } from '../lib/store-snapshot.js';
import { storeDir } from '../lib/scheduler.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const has = (name) => process.argv.includes(name);
const log = (m) => process.stderr.write(`[store-audit ${new Date().toISOString()}] ${m}\n`);

// Stamped at START, like the walker's: the question the scheduler asks is "has anyone BEGUN one
// recently", and a stamp written at the end lets every other server on the machine fire during the
// half-minute this one is still running.
writeAuditStamp({ source: process.env.MEMORY_TIMER_SOURCE || 'cli' });

const t0 = Date.now();
// 🟥 undefined, NOT `!has(...)`. Passing a boolean here overrides runAuditTick's default, which is
// where MEMORY_STORE_AUDIT_HEAL is read — so `heal: !has('--no-heal')` quietly turned the kill
// switch off for every run launched through this script, which is every run the scheduler makes.
// Caught by the public test asserting that HEAL=0 leaves the store untouched, and it did not.
const row = await runAuditTick({
  maxSessions: Number(arg('--max')) || undefined,
  heal: has('--no-heal') ? false : undefined,
  snapshot: has('--no-snapshot') ? false : undefined,
  log
});
if (has('--snapshot')) {
  const r = snapshotStore({ store: storeDir(), force: true });
  log(`snapshot (forced): ${JSON.stringify(r)} → ${snapshotDir(storeDir())}`);
}
log(`${row.outcome} in ${Date.now() - t0} ms — ${JSON.stringify(row)}`);
process.exit(row.outcome === 'audit-failed' ? 1 : 0);
