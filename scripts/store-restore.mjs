#!/usr/bin/env node
// scripts/store-restore.mjs — put store files back from a daily snapshot (lib/store-snapshot.js).
//
//   node scripts/store-restore.mjs store/.snapshots/store-2026-09-05.jsonl.gz --dry
//   node scripts/store-restore.mjs store/.snapshots/store-2026-09-05.jsonl.gz
//   node scripts/store-restore.mjs <snapshot> --only x-b58a69af-20260905T044521647Z.md
//   node scripts/store-restore.mjs <snapshot> --force        # also OVERWRITE what is there
//
// 🟥 MISSING FILES ONLY, unless --force. The reason anyone runs this is that something removed
// files, and a restore that also overwrote the ones still present would roll the store back to the
// snapshot — turning "I lost six exchanges" into "I lost every exchange since Tuesday". A file that
// exists is reported as skipped, by name, so nothing is quietly not done.
import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { ownStoreDir } from '../lib/config.js';
import { restoreSnapshot, snapshotDir, listSnapshots } from '../lib/store-snapshot.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const store = process.env.MEMORY_OWN_STORE_RESTORE_TARGET || ownStoreDir();

// The first bare argument that is not the VALUE of --only. Scanned by index rather than by
// argv.find(), which resolves a repeated string to its first position and would then read the flag
// before the wrong copy.
let file = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only') { i++; continue; }
  if (argv[i].startsWith('--')) continue;
  file = argv[i]; break;
}
if (!file) {
  const dir = snapshotDir(store);
  const have = listSnapshots(dir);
  console.log(`usage: store-restore.mjs <snapshot.jsonl.gz> [--only <name.md>] [--dry] [--force]`);
  console.log(`snapshots in ${dir}: ${have.length ? have.join(', ') : '(none yet)'}`);
  process.exit(2);
}
file = isAbsolute(file) ? file : resolve(process.cwd(), file);
if (!existsSync(file)) { console.error(`no such snapshot: ${file}`); process.exit(2); }
if (!store || !existsSync(store)) { console.error(`no store at ${store}`); process.exit(2); }

const before = readdirSync(store).filter((f) => f.endsWith('.md')).length;
const r = restoreSnapshot({ file, store, only: val('--only'), force: flag('--force'), dry: flag('--dry') });
const after = readdirSync(store).filter((f) => f.endsWith('.md')).length;

console.log(`snapshot : ${file} (${r.total} file(s))`);
console.log(`store    : ${store} — ${before} before, ${after} after`);
console.log(`restored : ${r.restored.length}${flag('--dry') ? ' (DRY RUN — nothing written)' : ''}`);
for (const n of r.restored.slice(0, 40)) console.log(`  + ${n}`);
if (r.restored.length > 40) console.log(`  …and ${r.restored.length - 40} more`);
if (r.skipped.length) console.log(`skipped  : ${r.skipped.length} already in the store (use --force to overwrite)`);
if (val('--only') && !r.restored.length && !r.skipped.length) {
  console.error(`--only ${val('--only')} is not in this snapshot`);
  process.exit(1);
}
// A restore changes the store without touching the index. Say so, rather than leaving the caller to
// discover it the next time a search does not find what they just put back.
if (!flag('--dry') && r.restored.length) console.log(`\nthe index does NOT know about these yet — run: npm run capture`);
