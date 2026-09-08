// lib/store-snapshot.js — THE TRANSCRIPT IS THE BACKUP, UNTIL IT ISN'T.
//
// MEM-50, and Daniel's question after MEM-39: should the app take snapshots? The honest first
// answer is no — every store file is DERIVED from a transcript on disk, and lib/store-audit.js plus
// the extractor rebuild any of them on demand. That is why this file is a hundred lines and not a
// backup product.
//
// 🟥 THE ONE FACT THAT MAKES IT NECESSARY ANYWAY: Claude Code prunes transcripts after 30 days by
// default. On day 31 the store stops being a derived artefact and becomes the only copy, and from
// then on the audit's self-heal has nothing to heal FROM. So: one gzipped JSONL of `store/*.md` a
// day, kept 14, written by the audit tick because the audit is already the thing that has just
// established the store is quiet and consistent.
//
// WHY JSONL.GZ AND NOT A TAR. `zlib` is in Node; `tar` is a spawned binary with a different flag
// dialect on every platform, and this project has already paid for one Windows-only difference in
// the capture path (MEM-38 #1). One line per file — `{name, mtimeMs, body}` — is also directly
// greppable after `gunzip -c`, which a tar of 2,916 files is not.
//
// WHAT IT IS NOT. It is not versioned, not incremental, and not encrypted. It sits inside `store/`,
// which every zip mode either never stages (`git archive` cannot see a gitignored directory) or
// deletes outright, and which lib/corpus.js listCorpusFiles() cannot see because that function
// reads one directory level and only `*.md`.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { sourceListingOf } from './corpus.js';
import { renameWithRetry } from './fs-retry.js';

export const DEFAULT_SNAPSHOT_HOURS = 24;
export const DEFAULT_SNAPSHOT_KEEP = 14;
const SNAP = /^store-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;

/** `store/.snapshots/` — a DOT directory inside the store, invisible to the corpus walk and to git. */
export function snapshotDir(store) {
  if (process.env.MEMORY_STORE_SNAPSHOT_DIR) return process.env.MEMORY_STORE_SNAPSHOT_DIR;
  return store ? join(store, '.snapshots') : null;
}

/** Hours between snapshots. `MEMORY_STORE_SNAPSHOT_HOURS=0` returns 0, which is OFF. */
export function snapshotHours() {
  const raw = process.env.MEMORY_STORE_SNAPSHOT_HOURS;
  const h = raw === undefined || raw === '' ? DEFAULT_SNAPSHOT_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h : 0;
}

export function snapshotKeep() {
  const raw = process.env.MEMORY_STORE_SNAPSHOT_KEEP;
  const k = raw === undefined || raw === '' ? DEFAULT_SNAPSHOT_KEEP : Number(raw);
  return Number.isFinite(k) && k >= 1 ? Math.floor(k) : DEFAULT_SNAPSHOT_KEEP;
}

/** `{at, digest, file}` of the last snapshot written, or null. */
export function readSnapshotState(dir) {
  const p = dir ? join(dir, '.last-snapshot.json') : null;
  if (!p || !existsSync(p)) return null;
  try { const o = JSON.parse(readFileSync(p, 'utf8')); return o && typeof o.at === 'string' ? o : null; }
  catch { return null; }
}

/** Newest first. Only files this module wrote — a stray file in the directory is never deleted. */
export function listSnapshots(dir) {
  if (!dir || !existsSync(dir)) return [];
  try { return readdirSync(dir).filter((f) => SNAP.test(f)).sort().reverse(); } catch { return []; }
}

/**
 * Write today's snapshot, unless it is not due or the store has not changed.
 *
 * 🟥 THE DIGEST GATE IS NOT AN OPTIMISATION, it is what stops fourteen identical copies of a store
 * nobody has written to from evicting the last fourteen DIFFERENT days — which is precisely the
 * history you want after a machine sits idle over a holiday. Same sha256 over sorted
 * `name:mtime:size` the index writers already use (lib/corpus.js sourceListingOf), so there is one
 * implementation of "has the store changed" and it cannot drift from theirs.
 *
 * @returns {{wrote:boolean, why?:string, file?:string, files?:number, bytes?:number,
 *            pruned?:string[], digest?:string, ms:number}}
 */
export function snapshotStore({ store, dir = snapshotDir(store), now = Date.now(),
  hours = snapshotHours(), keep = snapshotKeep(), force = false } = {}) {
  const t0 = Date.now();
  if (!store || !existsSync(store)) return { wrote: false, why: 'no store', ms: Date.now() - t0 };
  if (!force && !(hours > 0)) return { wrote: false, why: 'MEMORY_STORE_SNAPSHOT_HOURS=0', ms: Date.now() - t0 };

  const prev = readSnapshotState(dir);
  if (!force && prev) {
    const ageH = (now - Date.parse(prev.at)) / 3_600_000;
    if (Number.isFinite(ageH) && ageH >= 0 && ageH < hours) {
      return { wrote: false, why: `last snapshot ${ageH.toFixed(1)}h ago, due at ${hours}h`, ms: Date.now() - t0 };
    }
  }

  const listing = sourceListingOf(store);
  if (!force && prev && prev.digest === listing.digest) {
    return { wrote: false, why: 'the store is unchanged since the last snapshot', digest: listing.digest, ms: Date.now() - t0 };
  }

  const names = readdirSync(store).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  const lines = [];
  for (const name of names) {
    const p = join(store, name);
    let st, body;
    try { st = statSync(p); body = readFileSync(p, 'utf8'); } catch { continue; }   // vanished mid-pass
    lines.push(JSON.stringify({ name, mtimeMs: st.mtimeMs, body }));
  }
  const gz = gzipSync(Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8'));

  mkdirSync(dir, { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  const file = join(dir, `store-${day}.jsonl.gz`);
  // ATOMIC, and via renameWithRetry because a Windows virus scanner opening the temp file
  // microseconds after it is written is the failure MEM-38 #1 measured in the capture path.
  const tmp = file + '.tmp';
  writeFileSync(tmp, gz);
  renameWithRetry(tmp, file);
  try {
    writeFileSync(join(dir, '.last-snapshot.json'),
      JSON.stringify({ at: new Date(now).toISOString(), digest: listing.digest, file, files: lines.length }) + '\n', 'utf8');
  } catch { /* a state file that cannot be written costs one redundant snapshot */ }

  // PRUNE BY NAME, newest first. The names are ISO dates, so lexical order IS chronological order —
  // no stat, and no chance of an mtime touched by a backup tool reordering the history.
  const pruned = [];
  for (const f of listSnapshots(dir).slice(Math.max(1, keep))) {
    try { unlinkSync(join(dir, f)); pruned.push(f); } catch { /* someone else got there first */ }
  }
  return { wrote: true, file, files: lines.length, bytes: gz.length, pruned, digest: listing.digest, ms: Date.now() - t0 };
}

/**
 * Put files back. MISSING ONLY unless `force`, because the overwhelmingly likely reason anyone runs
 * this is that something deleted files — and an unconditional restore would then also roll back
 * every exchange captured since the snapshot, turning a partial loss into a total one.
 *
 * @returns {{restored:string[], skipped:string[], missingFromSnapshot:boolean, total:number}}
 */
export function restoreSnapshot({ file, store, only = null, force = false, dry = false } = {}) {
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  const restored = [], skipped = [];
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row.name !== 'string' || typeof row.body !== 'string') continue;
    total++;
    if (only && row.name !== only) continue;
    const dest = join(store, row.name);
    if (existsSync(dest) && !force) { skipped.push(row.name); continue; }
    if (!dry) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, row.body, 'utf8');
    }
    restored.push(row.name);
  }
  return { restored, skipped, missingFromSnapshot: !!(only && !restored.length && !skipped.length), total };
}
