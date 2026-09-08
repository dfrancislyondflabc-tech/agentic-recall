#!/usr/bin/env node
// scripts/audit-store.mjs — does the store agree with the transcripts it came from? (lib/store-audit.js)
//
//   npm run audit:store                 every session with a transcript on disk
//   npm run audit:store -- --max 20     the 20 most recently touched sessions
//
// Exit 0 when the only problems are `missing` (expected for live sessions: the in-flight exchange, or
// growth since the last capture); exit 1 on orphans, duplicate bodies, order or dangling links.
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { audit } from '../lib/store-audit.js';
import { ownStoreDir } from '../lib/config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const i = process.argv.indexOf('--max');
const maxSessions = i !== -1 ? Number(process.argv[i + 1]) || Infinity : Infinity;
// A fresh install has no store: say so and exit clean, rather than throwing ENOENT out of readdirSync
// with a stack trace. (Found by running this on a clean HOME — the shipped tree, not the repo.)
const storeDir = ownStoreDir();
if (!storeDir || !existsSync(storeDir)) {
  console.log(`no capture store at ${storeDir} yet — nothing to audit. (It is created the first time a conversation is captured.)`);
  process.exit(0);
}
const r = audit({ storeDir, transcriptDirs: null, extractor: join(ROOT, 'scripts/ingest-transcript.js'), maxSessions });
const byKind = {}; for (const p of r.problems) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
console.log(`store   : ${ownStoreDir()}`);
console.log(`sessions: ${r.sessions} audited, ${r.skipped} skipped (no transcript on disk)`);
console.log(`problems: ${r.problems.length} ${JSON.stringify(byKind)}`);
for (const p of r.problems.filter((p) => p.kind !== 'missing').slice(0, 40)) console.log(`  ${p.kind.padEnd(15)} ${p.session.slice(0, 8)} ${p.file || p.name || ''} ${p.detail || ''}`);
const missing = r.problems.filter((p) => p.kind === 'missing');
if (missing.length) console.log(`  (${missing.length} missing: expected for live sessions — the in-flight exchange or growth since the last capture)`);
process.exit(r.problems.some((p) => p.kind !== 'missing') ? 1 : 0);
