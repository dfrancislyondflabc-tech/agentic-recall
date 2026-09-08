#!/usr/bin/env node
// scripts/migrate-stable-names.mjs — one-time: positional exchange names -> content-stable names.
//
//   node scripts/migrate-stable-names.mjs            dry run: prints the plan and every check
//   node scripts/migrate-stable-names.mjs --apply    renames, rewrites name: and Previous:, verifies
//
// FROM  x-<sid8>-NNNN                     (position in the transcript; renumbers when a rule changes)
// TO    x-<sid8>-20260903T054233800Z      (the ask's timestamp, compacted; a property of the exchange)
//
// WHY. Positional names cost real memories in one night: a withdrawn rule renumbered 715 files and
// left 19 duplicates; a windowed run numbered from 1 and overwrote a session's first two; a bound
// computed from the ordinal deleted a real file (MEM-19/20/21). The new name cannot do any of that.
//
// WHAT IT TOUCHES, per file (write temp, rename over; old file removed only after EVERY new one exists):
//   * the `name:` frontmatter line          (lib/corpus.js reads identity from frontmatter, not the filename)
//   * the LAST `Previous: [[…]]` line      (to the PREDECESSOR's new name; the last, because a body may quote one)
//   * the filename
// Then remaps `.dream-state.json` (`acceptedSecrets` keyed by name, `curated` keyed by store/<file>) and
// RETIRES the staging index (renamed *.pre-migration) so nothing can serve the old names -- searches
// rebuild it on first use, or run memory({action:"index", scope:"staging"}).
//
// PRE-CHECKS (refuses to apply if any fails):
//   * every old-shape file has a `ts` that compacts to ^\d{8}T\d{9}Z$  -- a MISSING ts REFUSES. The
//     writer's fallback name hashes the raw ask + turn index, which this script cannot reproduce from
//     the redacted stored text, so inventing one here would make the next ingest write a second file.
//   * no two files -- old-shape OR already new-shape, ANY session sharing the 8-char prefix -- would
//     occupy the same new name (reviewed: the first version scoped this per session and only over
//     old-shape files, so it said "ok" and then clobbered an existing new-shape file and a
//     prefix-sharing session's file)
//   * per session, the new lexicographic order equals the old positional order (zero reorders)
// AFTER: file count unchanged; every name: equals its basename; every Previous: target exists; zero
// old-shape files remain.
//
// Back up store/ first -- it is gitignored, so that copy is the only one.
import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ownStoreDir, stagingIndexPath } from '../lib/config.js';

const APPLY = process.argv.includes('--apply');
const dir = process.env.MEMORY_OWN_STORE || ownStoreDir();
// A FRESH INSTALL HAS NO STORE, and the README tells a new reader to run this once. "Nothing to
// migrate" is the truth there, not an error — found by running the shipped tree's own documented
// commands on a clean HOME, which is the only way this class of defect ever shows up.
if (!dir || !existsSync(dir)) {
  console.log(`no capture store at ${dir} yet — nothing to migrate. (It is created the first time a conversation is captured.)`);
  process.exit(0);
}

const OLD = /^x-([0-9a-f]{8})-(\d{4})\.md$/;
const stamp = (ts) => new Date(ts).toISOString().replace(/[-:.]/g, '');
const headOf = (raw) => raw.slice(0, raw.indexOf('\n---', 4) + 1 || 4000);
const field = (raw, key) => (new RegExp(`^  ${key}: (.+)$`, 'm').exec(headOf(raw)) || [])[1] || null;
const nameOf = (raw) => (/^name: (\S+)$/m.exec(headOf(raw)) || [])[1] || null;
const lastPrevious = (raw) => { const all = [...raw.matchAll(/^Previous: \[\[([^\]]+)\]\]$/gm)]; return all.length ? all[all.length - 1] : null; };

// ---- plan ---------------------------------------------------------------------------------------
const allMd = readdirSync(dir).filter((f) => f.endsWith('.md'));
const files = allMd.filter((f) => OLD.test(f)).sort();
const totalBefore = allMd.length;
const bySession = new Map();
const problems = [];
for (const f of files) {
  const raw = readFileSync(join(dir, f), 'utf8');
  const [, sid8, ord] = OLD.exec(f);
  const sessionId = field(raw, 'sessionId');
  const ts = field(raw, 'ts');
  if (!sessionId) { problems.push(`${f}: no sessionId in frontmatter`); continue; }
  if (nameOf(raw) !== basename(f, '.md')) problems.push(`${f}: name: is ${nameOf(raw)}, not the basename`);
  if (!ts || !Number.isFinite(new Date(ts).getTime())) { problems.push(`${f}: no usable ts -- the writer's fallback name cannot be reproduced here; re-ingest this session with the current extractor instead`); continue; }
  const key = `${sid8}|${sessionId}`;
  if (!bySession.has(key)) bySession.set(key, []);
  bySession.get(key).push({ f, ord: Number(ord), ts, raw, sid8 });
}
const plan = new Map();          // old basename (no .md) -> new basename (no .md)
const taken = new Map();         // new basename -> who holds it (existing new-shape file, or a planned rename)
for (const f of allMd) if (!OLD.test(f)) taken.set(basename(f, '.md'), `existing file ${f}`);
for (const [key, list] of bySession) {
  list.sort((a, b) => a.ord - b.ord);
  for (const e of list) {
    const suffix = stamp(e.ts);
    if (!/^\d{8}T\d{9}Z$/.test(suffix)) { problems.push(`${e.f}: ts ${e.ts} compacts to ${suffix}, wrong shape`); continue; }
    e.newName = `x-${e.sid8}-${suffix}`;
    if (taken.has(e.newName)) problems.push(`${e.f} -> ${e.newName}: target already taken by ${taken.get(e.newName)}`);
    taken.set(e.newName, `planned rename of ${e.f}`);
    plan.set(basename(e.f, '.md'), e.newName);
  }
  const byNew = [...list].filter((e) => e.newName).sort((a, b) => (a.newName < b.newName ? -1 : a.newName > b.newName ? 1 : 0));
  for (let i = 0; i < byNew.length; i++) if (byNew[i] !== list[i]) { problems.push(`${key}: order changes at position ${i + 1} (${list[i].f} vs ${byNew[i].f})`); break; }
}
console.log(`store        : ${dir}`);
console.log(`old-shape    : ${files.length} files in ${bySession.size} session(s)`);
console.log(`other files  : ${totalBefore - files.length} (already migrated or not exchanges)`);
if (problems.length) {
  console.error(`\nREFUSING: ${problems.length} pre-check problem(s)`);
  for (const p of problems.slice(0, 20)) console.error('  ' + p);
  process.exit(3);
}
console.log('pre-checks   : ok (every ts compacts, no target taken by ANY existing or planned file, order unchanged in every session)');
for (const [o, n] of [...plan.entries()].slice(0, 3)) console.log(`  ${o}  ->  ${n}`);
if (!files.length) { console.log('\nnothing to migrate.'); process.exit(0); }
if (!APPLY) { console.log('\nDRY RUN — pass --apply to migrate. Back up store/ first.'); process.exit(0); }

// ---- apply --------------------------------------------------------------------------------------
let rewritten = 0, linksRewritten = 0, linksLeft = 0;
for (const [, list] of bySession) {
  for (const e of list) {
    let raw = e.raw.replace(/^name: \S+$/m, `name: ${e.newName}`);
    const lp = lastPrevious(raw);
    if (lp) {
      const n = plan.get(lp[1]);
      if (n) { raw = raw.slice(0, lp.index) + `Previous: [[${n}]]` + raw.slice(lp.index + lp[0].length); linksRewritten++; }
      else linksLeft++;
    }
    const target = join(dir, `${e.newName}.md`);
    if (existsSync(target)) { console.error(`ABORT: ${target} appeared during the run; nothing else touched`); process.exit(4); }
    const tmp = join(dir, `.${e.newName}.md.tmp`);
    writeFileSync(tmp, raw, 'utf8');
    renameSync(tmp, target);
    rewritten++;
  }
}
// Remove the old files only after EVERY new one is in place, so a crash mid-way leaves both copies.
let removed = 0;
for (const [, list] of bySession) for (const e of list) if (existsSync(join(dir, e.f))) { unlinkSync(join(dir, e.f)); removed++; }

// Dream state: acceptedSecrets is keyed by NAME, curated by FILE (store/<name>.md). Both remapped.
const dreamState = join(dir, '.dream-state.json');
let remappedSecrets = 0, remappedCurated = 0;
if (existsSync(dreamState)) {
  try {
    const s = JSON.parse(readFileSync(dreamState, 'utf8'));
    const remapKeys = (obj, toKey, fromKey) => {
      if (!obj) return obj;
      const next = {};
      for (const [k, v] of Object.entries(obj)) { const o = fromKey(k); const n = o && plan.get(o); if (n) { next[toKey(n)] = v; remapCount++; } else next[k] = v; }
      return next;
    };
    let remapCount = 0;
    s.acceptedSecrets = remapKeys(s.acceptedSecrets, (n) => n, (k) => k); remappedSecrets = remapCount; remapCount = 0;
    s.curated = remapKeys(s.curated, (n) => `store/${n}.md`, (k) => (/^store\/(x-[0-9a-f]{8}-\d{4})\.md$/.exec(k) || [])[1] || null); remappedCurated = remapCount;
    writeFileSync(dreamState, JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch (e) { console.error(`dream state not remapped: ${e.message}`); }
}

// Retire the staging index: it holds the OLD names, and a search served from it would hand back
// names that no longer exist on disk. Renamed, not deleted, so it can be inspected.
let indexRetired = false;
try {
  const idx = stagingIndexPath();
  if (idx && existsSync(idx)) { renameSync(idx, `${idx}.pre-migration`); indexRetired = true; }
} catch (e) { console.error(`staging index not retired: ${e.message}`); }

// ---- verify -------------------------------------------------------------------------------------
{
  const after = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const stillOld = after.filter((f) => OLD.test(f)).length;
  const names = new Set(after.map((f) => basename(f, '.md')));
  let badName = 0, dangling = 0;
  for (const f of after) {
    const raw = readFileSync(join(dir, f), 'utf8');
    if (nameOf(raw) !== basename(f, '.md')) badName++;
    const lp = lastPrevious(raw);
    if (lp && !names.has(lp[1])) dangling++;
  }
  console.log(`\nrewritten ${rewritten}, links rewritten ${linksRewritten}, links left as-is ${linksLeft}, old files removed ${removed}`);
  console.log(`dream state: ${remappedSecrets} secret key(s), ${remappedCurated} curated key(s) remapped; staging index ${indexRetired ? 'retired (*.pre-migration)' : 'not present'}`);
  console.log(`after: ${after.length} .md files (expected ${totalBefore}); still old-shape ${stillOld}; name!=basename ${badName}; dangling Previous ${dangling}`);
  if (stillOld || badName || dangling || after.length !== totalBefore) { console.error('VERIFY FAILED — restore store/ from the backup and investigate'); process.exit(4); }
  console.log('verify: ok. Rebuild the staging index now: memory({action:"index", scope:"staging"}).');
}
