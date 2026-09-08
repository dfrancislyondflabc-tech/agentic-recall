// lib/store-audit.js — does the store agree with the transcripts it was extracted from?
//
// Built after a night in which 19 duplicate memories and one deleted real one sat in the store with
// nothing reporting either (MEM-20/21). For every session whose transcript is still on disk, the
// extractor is run into a scratch store and the two sets of files are compared:
//
//   missing         an exchange the extractor yields today has no file in the store
//                   (expected for a live session: the in-flight exchange, or growth since capture)
//   orphan          a file of the session that the extractor does not yield (a stale tail)
//   duplicate-body  two files of one session with the same body
//   order           file order (name) disagrees with ask-time order (ts)
//   dangling-prev   a Previous: link whose target is not in the store
//   no-session      a store file with no sessionId in frontmatter
//   orphan-temp     a `<name>.md.<pid>.tmp` left by a writer that was killed between write and
//                   rename (MEM-34's atomic write, MEM-55). Session-less by nature — it has no
//                   readable frontmatter — so it is reported against the store, not a session.
//
// Read-only. The scratch extraction runs with MEMORY_GIT_REPOS='' and --backfill so it neither
// hits git nor stamps an account. Used as a GATE on fixtures and an ADVISORY on the live store
// (test/run-tests.js a69), and from `npm run audit:store`.
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSyncHidden } from './child.js';   // MEM-83: no console window on Windows
import { createHash } from 'node:crypto';

const NAME = /^x-([^-]+)-(.+)\.md$/;
// process.kill(pid, 0) sends no signal; it asks whether the pid can be signalled. EPERM means
// "alive, and not yours", which is still alive. Same reading as scripts/auto-ingest.js and
// lib/scheduler.js, deliberately — three copies of one rule that must not drift apart.
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const headOf = (raw) => raw.slice(0, raw.indexOf('\n---', 4) + 1 || 4000);
const field = (raw, key) => (new RegExp(`^  ${key}: (.+)$`, 'm').exec(headOf(raw)) || [])[1]?.trim() || null;
const bodyOf = (raw) => { const i = raw.indexOf('\n---', 4); return i === -1 ? raw : raw.slice(i + 4).replace(/\nPrevious: \[\[[^\]]+\]\]\n?$/, '').trim(); };

// Exported (2026-09-05) so lib/store-audit-tick.js can find the transcript of a session it has
// decided to repair, without a second implementation of "where do transcripts live". A second
// implementation is how the walker ended up ignoring MEMORY_TRANSCRIPT_DIR (MEM-38 #4) — and this
// function was the NEXT reader making that same mistake: an override names ONE folder of
// transcripts, and this walked ~/.claude/projects regardless. Now it honours the override, on the
// same terms as scripts/auto-ingest.js:103 and lib/capture-status.js:105.
export function defaultTranscriptDirs() {
  if (process.env.MEMORY_TRANSCRIPT_DIR) return [process.env.MEMORY_TRANSCRIPT_DIR];
  const root = join(homedir(), '.claude', 'projects');
  try { return readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(d)); } catch { return []; }
}

export function findTranscript(sessionId, dirs) {
  for (const d of dirs) { const p = join(d, `${sessionId}.jsonl`); if (existsSync(p)) return p; }
  return null;
}

/**
 * EVERY SESSION A STAMP CLAIMS WAS CAPTURED BUT THAT HAS NO FILE IN THE STORE AT ALL.
 *
 * 🟥 THE BLIND SPOT THIS CLOSES, found by (a84) while planting a MEM-39. The session list above is
 * built from the STORE, so a session whose files are all missing is not in it — and "all missing"
 * is precisely the end state of the bug this whole module exists to detect. The audit looked
 * straight past a planted, fully-deleted session and reported the store clean.
 *
 * `store/.last-ingest.json` (scripts/auto-ingest.js:277) maps transcript path -> {at, size}: it is
 * the debounce stamp, and it is the LIAR in MEM-39. It is read here NOT to be believed but to
 * enumerate CLAIMS — "this transcript was captured at 6.8 MB" — that the extractor can then
 * falsify. A session with no stamp and no store files was never claimed and is `uncaptured`, which
 * is lib/capture-status.js's question and not this one; including those would turn every chat that
 * belongs to another account into an hourly alarm.
 *
 * @returns {string[]} session ids
 */
function stampedButEmpty(storeDir, dirs, haveSessions) {
  try {
    const stamps = JSON.parse(readFileSync(join(storeDir, '.last-ingest.json'), 'utf8'));
    const out = [];
    for (const txPath of Object.keys(stamps || {})) {
      const sid = basename(String(txPath), '.jsonl');
      if (!sid || haveSessions.has(sid)) continue;
      if (!findTranscript(sid, dirs)) continue;              // no transcript, nothing to compare to
      out.push(sid);
    }
    return out;
  } catch { return []; }                                     // no stamp file is the healthy shape
}

/**
 * @param {object} o
 * @param {string} o.storeDir
 * @param {string[]|null} o.transcriptDirs   null = every ~/.claude/projects/<dir>
 * @param {string} o.extractor               path to scripts/ingest-transcript.js
 * @param {number} [o.maxSessions]           audit only the N most recently modified sessions
 * @param {boolean} [o.claimedSessions]      also audit sessions a stamp claims but the store has none of
 * @returns {{ sessions: number, skipped: number, problems: Array<{kind:string, session:string, file?:string, name?:string, detail?:string}> }}
 */
export function audit({ storeDir, transcriptDirs, extractor, maxSessions = Infinity, claimedSessions = true }) {
  const dirs = transcriptDirs || defaultTranscriptDirs();
  const problems = [];
  const bySession = new Map();     // sessionId -> [{ file, name, ts, raw }]
  // ORPHANED TEMPS ARE NAMED HERE EVEN THOUGH scripts/auto-ingest.js SWEEPS THEM (MEM-55).
  // The sweep is an actuator and only runs when there is an ingest to do; the audit is the channel
  // that SAYS SO, and on a machine where capture has stopped the sweep is exactly what is not
  // running. Same two tests as the sweep, so the two never disagree: a temp whose pid is alive and
  // whose mtime is inside the window is a writer mid-rename, not debris.
  const TMP_MAX_AGE_MS = Number(process.env.MEMORY_STORE_TMP_MAX_AGE_MS ?? 600_000);
  for (const f of readdirSync(storeDir)) {
    const t = /^(.+)\.(\d+)\.tmp$/.exec(f);
    if (t) {
      const pid = parseInt(t[2], 10);
      let ageMs = Infinity; try { ageMs = Date.now() - statSync(join(storeDir, f)).mtimeMs; } catch { /* vanished */ }
      if (!(pidAlive(pid) && ageMs < TMP_MAX_AGE_MS)) {
        problems.push({ kind: 'orphan-temp', session: '?', file: f,
          detail: `left by pid ${pid} (${Math.round(ageMs / 1000)}s old); a writer killed between write and rename` });
      }
      continue;
    }
    if (!NAME.test(f)) continue;
    const raw = readFileSync(join(storeDir, f), 'utf8');
    const sessionId = field(raw, 'sessionId');
    if (!sessionId) { problems.push({ kind: 'no-session', session: '?', file: f }); continue; }
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push({ file: f, name: basename(f, '.md'), ts: field(raw, 'ts'), raw, mtime: statSync(join(storeDir, f)).mtimeMs });
  }
  const allNames = new Set([...bySession.values()].flat().map((e) => e.name));

  // Most recently touched sessions first, so a capped audit looks at what is live.
  const order = [...bySession.entries()].sort((a, b) => Math.max(...b[1].map((e) => e.mtime)) - Math.max(...a[1].map((e) => e.mtime)));
  // The stamped-but-empty sessions go FIRST, ahead of the mtime order: they are the only candidates
  // that are certainly wrong, and a maxSessions cap must not be able to hide one behind twenty
  // healthy sessions that happen to have been written to more recently.
  if (claimedSessions) {
    for (const sid of stampedButEmpty(storeDir, dirs, new Set(bySession.keys())).reverse()) order.unshift([sid, []]);
  }
  let sessions = 0, skipped = 0;
  for (const [sessionId, files] of order) {
    if (sessions >= maxSessions) break;
    const tx = findTranscript(sessionId, dirs);
    if (!tx) { skipped++; continue; }
    sessions++;

    // S3 duplicate bodies, S4 order, S5 dangling Previous -- from the store alone.
    const seen = new Map();
    for (const e of files) {
      const h = createHash('sha256').update(bodyOf(e.raw)).digest('hex');
      if (seen.has(h)) problems.push({ kind: 'duplicate-body', session: sessionId, file: e.file, detail: `same body as ${seen.get(h)}` });
      else seen.set(h, e.file);
      const m = /^Previous: \[\[([^\]]+)\]\]$/m.exec(e.raw);
      if (m && !allNames.has(m[1])) problems.push({ kind: 'dangling-prev', session: sessionId, file: e.file, detail: m[1] });
    }
    const byName = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const byTs = [...files].filter((e) => e.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (byTs.length === files.length) {
      for (let i = 0; i < files.length; i++) if (byName[i] !== byTs[i]) { problems.push({ kind: 'order', session: sessionId, file: byName[i].file, detail: `position ${i + 1}: by name ${byName[i].name}, by ts ${byTs[i].name}` }); break; }
    }

    // S1/S2: what the extractor yields today vs what the store holds.
    const scratch = mkdtempSync(join(tmpdir(), 'store-audit-'));
    try {
      const r = spawnSyncHidden(process.execPath, [extractor, tx, '--write', '--backfill'],
        { encoding: 'utf8', env: { ...process.env, MEMORY_OWN_STORE: scratch, MEMORY_GIT_REPOS: '', MEMORY_PRUNE_ORPHANS: '0' }, maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) { problems.push({ kind: 'extractor-failed', session: sessionId, detail: (r.stderr || '').slice(0, 200) }); continue; }
      const expected = new Set(readdirSync(scratch).filter((f) => f.endsWith('.md')));
      const have = new Set(files.map((e) => e.file));
      for (const f of expected) if (!have.has(f)) problems.push({ kind: 'missing', session: sessionId, file: f });
      for (const f of have) if (!expected.has(f)) problems.push({ kind: 'orphan', session: sessionId, file: f });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  return { sessions, skipped, problems };
}
