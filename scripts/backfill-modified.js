#!/usr/bin/env node
// scripts/backfill-modified.js — the ONE-TIME git-floor backfill (Phase 2a).
//
//   node scripts/backfill-modified.js [--apply]
//
// Dry by default. For every curated memory that has frontmatter and NO
// metadata.modified, stamp the newest memory-repo commit date touching that
// file — explicitly recorded as `modifiedSource: git-floor`, because it is a
// FLOOR, not fact-time: the memory repo only exists since 2026-08-23, so a
// memory written in May carries an August floor. That is still strictly more
// honest than the status quo, where 110 of 140 files shared one bulk mtime
// from the 2026-08-19 account backfill and "newest first" ordered by
// bookkeeping.
//
// NEVER overwrites an existing stamp (hand-set or hook-set — those are better
// claims than a floor). Never touches a body (setModified is frontmatter-only
// surgery). Skips MEMORY.md by construction: it has no frontmatter and
// setModified refuses to create one — see the rationale in lib/corpus.js.
// Idempotent: a second run changes zero bytes, because every file then either
// has a stamp or is the refused index file.

import { execFileSyncHidden } from '../lib/child.js';   // MEM-83: no console window on Windows
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDir } from '../lib/config.js';
import { parseFrontmatter, setModified } from '../lib/corpus.js';

const APPLY = process.argv.includes('--apply');
const dir = memoryDir();

const lastTouch = (file) => {
  try {
    return execFileSyncHidden('git', ['-C', dir, 'log', '-1', '--format=%aI', '--', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
  } catch (_) { return null; }
};

let stamped = 0, kept = 0, refused = 0, noGit = 0;
const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
  const full = join(dir, f);
  const { front } = parseFrontmatter(readFileSync(full, 'utf8'));
  if (!front) { refused++; rows.push(`  refuse  ${f}  (no frontmatter — the context-loaded index file)`); continue; }
  if (front.metadata && front.metadata.modified) { kept++; continue; }
  const iso = lastTouch(f);
  if (!iso) { noGit++; rows.push(`  no-git  ${f}  (never committed — the Stop hook will stamp its first change)`); continue; }
  if (APPLY) {
    const r = setModified(full, iso, 'git-floor');
    if (r.changed) stamped++; else rows.push(`  odd     ${f}  (${r.reason})`);
  } else {
    stamped++;
  }
  rows.push(`  ${APPLY ? 'stamp' : 'would '}  ${f}  -> ${iso}`);
}

console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} over ${dir}`);
console.log(`  ${APPLY ? 'stamped' : 'would stamp'}: ${stamped}   kept existing: ${kept}   refused (no frontmatter): ${refused}   uncommitted: ${noGit}`);
for (const r of rows.slice(0, 200)) console.log(r);
if (!APPLY) console.log('\nDRY RUN — pass --apply to write the stamps (frontmatter-only).');
