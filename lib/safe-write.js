// lib/safe-write.js — the ONE door through which this server writes into a memory folder it does
// not own (the curated folder is Claude Code's own memory; `import` targets it too).
//
// THREAT MODEL. A user points this server at memories they already have. Nothing here may lose or
// corrupt them. Inventory of writers (2026-09-03): four rewrite FRONTMATTER ONLY (tier, modified,
// account/origin stamps), `import` creates NEW files, and a `replace` import ARCHIVES the old copy.
// No code path deletes a curated file. The residual risk is a frontmatter-splitting bug turning a
// metadata rewrite into a truncation -- `indexOf('\n---') === -1` and a slice(-1) would do it.
//
// So every rewrite goes through rewriteFrontmatterOnly(), which
//   1. refuses entirely when MEMORY_CURATED_READ_ONLY=1 (index and search only -- for anyone who
//      wants the guarantee rather than the argument);
//   2. asserts the BODY is byte-identical before and after -- a metadata edit that changes one
//      character of content is refused and reported, never written;
//   3. snapshots the previous bytes to <dir>/.memory-snapshots/<name>.<ts>.md first (newest 5 kept
//      per file), so even a correct metadata edit is undoable without git;
//   4. writes atomically (temp file + rename), so a crash leaves the old file or the new one, never
//      a partial.
// New files go through writeNewMemoryFile(), which honours the read-only switch and never overwrites.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

export const SNAPSHOT_DIR = '.memory-snapshots';
// 🟥 CLAMPED TO >= 1. Unclamped, `Number(env || 5)` let a caller set 0 or a negative number, and
// snapshot() prunes `mine.slice(0, mine.length - N)` -- so at 0 or below that selects EVERY snapshot
// INCLUDING the one just written. Each edit silently deleted its own backup, with no warning, while
// MEMORY-SAFETY.md advertises snapshots as the recovery path. Measured before the fix: values 0 and
// -1 both left 0 snapshots after three edits; 5 (default) and 1 behaved.
//
// Two guards, and it is worth saying which catches what, because they are not interchangeable:
//   `|| 5`      catches 0 (falsy) and NaN from a non-numeric value  -> the default, 5
//   `Math.max`  catches negatives                                    -> 1
// Verified after the change: 0 -> 5, -1 -> 1, "five" -> 5, 1 -> 1, unset -> 5; every one keeps at
// least one snapshot and leaves the original byte-identical.
export const SNAPSHOTS_PER_FILE = Math.max(1, Number(process.env.MEMORY_SNAPSHOTS_PER_FILE) || 5);
export const readOnly = () => process.env.MEMORY_CURATED_READ_ONLY === '1';

/**
 * The content after the frontmatter block; the whole text when there is no frontmatter.
 * The single blank line conventionally separating frontmatter from body is not body: a writer that
 * emits one blank line where another emitted two must not read as "the content changed".
 */
export function bodyOf(raw) {
  const s = String(raw);
  if (!s.startsWith('---')) return s;
  const end = s.indexOf('\n---', 3);
  if (end === -1) return s;                                   // opener with no closer: it is all body
  const after = s.indexOf('\n', end + 1);
  if (after === -1) return '';
  return s.slice(after + 1).replace(/^\n+/, '');
}

function snapshot(fullPath, prevRaw) {
  const dir = join(dirname(fullPath), SNAPSHOT_DIR);
  mkdirSync(dir, { recursive: true });
  const name = basename(fullPath, '.md');
  const ts = new Date().toISOString().replace(/[-:.]/g, '');
  writeFileSync(join(dir, `${name}.${ts}.md`), prevRaw, 'utf8');
  // Keep the newest N per file.
  //
  // MATCH THE SNAPSHOT NAME EXACTLY, never by bare prefix. A memory whose name contains a dot
  // makes a shorter sibling's prefix filter swallow it: with `alpha` and `alpha.beta`, the filter
  // `startsWith('alpha.')` also matches `alpha.beta.<ts>.md`, and because `alpha.2026...` sorts
  // before `alpha.beta...` the prune deletes alpha's OWN snapshots first. Measured 2026-09-04:
  // six rewrites of `alpha` left it with ZERO snapshots while its sibling kept five — the safety
  // net silently empty for the file that was actually being edited. Dotted names cannot come from
  // importSlug() (it strips dots), but a memory written directly as a file is not slugged, and
  // version-shaped slugs like `bge-small-en-v1.5` are ordinary.
  const mineRe = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{8}T\\d+Z\\.md$`);
  const mine = readdirSync(dir).filter((f) => mineRe.test(f)).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - SNAPSHOTS_PER_FILE))) { try { unlinkSync(join(dir, old)); } catch { /* best effort */ } }
}

function atomicWrite(fullPath, content) {
  const tmp = join(dirname(fullPath), `.${basename(fullPath)}.${process.pid}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, fullPath);
}

/**
 * Rewrite a memory file changing ONLY its frontmatter.
 * @returns {{written:boolean, refused?:string, snapshot?:boolean}}
 */
export function rewriteFrontmatterOnly(fullPath, nextRaw, { allowNewFrontmatter = false } = {}) {
  if (readOnly()) return { written: false, refused: 'MEMORY_CURATED_READ_ONLY=1: this server does not write to the memory folder' };
  const prevRaw = readFileSync(fullPath, 'utf8');
  if (prevRaw === nextRaw) return { written: false, refused: 'unchanged' };
  const prevBody = bodyOf(prevRaw), nextBody = bodyOf(nextRaw);
  // Adding frontmatter to a file that had none is allowed only when asked for, and then the whole
  // previous text must survive as the body.
  const bodyKept = allowNewFrontmatter && !prevRaw.startsWith('---') ? nextBody.trimEnd() === prevRaw.trimEnd() : nextBody === prevBody;
  if (!bodyKept) {
    return { written: false, refused: `body would change (${prevBody.length} -> ${nextBody.length} chars); a frontmatter edit may not touch content -- nothing written` };
  }
  // BELT AND BRACES, and honestly labelled as such: mutation-tested, this branch is unreachable while
  // the body check above stands (an unclosed block makes bodyOf return the whole text, which then
  // cannot equal the previous body). Kept because it is the failure mode that would matter most if
  // the comparison above were ever loosened.
  if (!nextRaw.startsWith('---') || nextRaw.indexOf('\n---', 3) === -1) {
    return { written: false, refused: 'result has no closed frontmatter block -- nothing written' };
  }
  snapshot(fullPath, prevRaw);
  atomicWrite(fullPath, nextRaw);
  return { written: true, snapshot: true };
}

/**
 * Create a memory file that does not exist yet. Never overwrites.
 * `supersededTo` is the ONE exception, and it is not really one: `import … replace` moves the old
 * version into archive/ first and passes the archived path here, so the previous bytes still exist
 * on disk under a name that says why. Passing it without having archived anything would be a lie,
 * so it takes the archived path rather than a boolean -- the caller has to have done the work.
 */
export function writeNewMemoryFile(fullPath, content, { supersededTo = null } = {}) {
  if (readOnly()) return { written: false, refused: 'MEMORY_CURATED_READ_ONLY=1: this server does not write to the memory folder' };
  if (existsSync(fullPath)) {
    if (!supersededTo) return { written: false, refused: 'exists -- a new memory never overwrites an existing file' };
    if (!existsSync(join(dirname(fullPath), supersededTo))) {
      return { written: false, refused: `refusing to replace: the previous version is not at ${supersededTo}` };
    }
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  atomicWrite(fullPath, content);
  return { written: true, ...(supersededTo ? { supersededTo } : {}) };
}
