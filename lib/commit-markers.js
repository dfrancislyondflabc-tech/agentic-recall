// lib/commit-markers.js — THE COMMITS A SESSION RAN ITSELF, read from its own tool calls (MEM-118).
//
// WHY. Capture links commits to exchanges by TIME (scripts/ingest-transcript.js C1, lib/git-join.js): a commit in a
// configured repo that landed after an ask is attributed to it. That cannot tell this session's commit from another
// session's in the same minutes, misses repos nobody listed in MEMORY_GIT_REPOS, and cannot see a commit that FAILED
// (a pre-commit hook, a failing test, "nothing to commit") — which is exactly the case where the conversation says
// "committed" and nothing landed.
//
// WHAT. The transcript already holds the proof. A shell tool call whose command runs `git … commit`, and its tool result:
// git prints `[<branch> <sha>] <subject>` when a commit lands. So the marker is decided from the OUTPUT, not the command
// — a chained `git add && git commit && git push` or a hook that blocks it both read correctly. Stored: the short SHA,
// whether it landed, and the repo folder name when the command names it (`cd <dir> &&` or `git -C <dir>`). NO committed
// text and no command text is kept: tool traffic stays out of the store (the extractor's security rule), and a SHA is
// enough for git to supply files and message on demand.

// `git` must START a command (line start, or after ; && || | ( then do) — so `grep 'git commit' notes.md` is not a commit.
const COMMIT_CMD = /(?:^|[;&|(\n]|\bthen|\bdo)\s*git(?:\s+(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit(?![\w-])(?![^\n;&|]*--dry-run)/;
const LANDED = /^\[[^\]\n]*?\b([0-9a-f]{7,40})\]\s/gm;
const PUSHED = /^\s*[0-9a-f]{7,40}\.\.([0-9a-f]{7,40})\s+\S+\s+->\s/gm;     // `   56d05de..0fca810  main -> main`
const NOT_LANDED = /nothing to commit|no changes added to commit|nothing added to commit|pre-commit hook|hook failed|Aborting commit/i;

function textOfResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/** The folder a commit command runs in, as a folder NAME (never the path), when the command says so. */
export function repoHintOf(cmd) {
  const s = String(cmd || '');
  const m = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s[^;&|]*\bcommit\b/.exec(s) ||
    /\bcd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)[^;|]*?\bgit\b[^;|]*\bcommit\b/.exec(s);
  if (!m) return null;
  const dir = m[1].replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '');
  const name = dir.split(/[\\/]/).filter(Boolean).pop() || null;
  return name && !/^[.~]$/.test(name) && !name.includes('$') ? name : null;
}

/** Is this shell command a git commit (not a dry run)? */
export function isCommitCommand(cmd) { return COMMIT_CMD.test(String(cmd || '')); }

/** The SHAs git reported as landed in this output: `[main 3ed5fde] subject`, or a push of it (`a..3ed5fde main -> main`). */
export function landedShas(output) {
  const t = String(output || '');
  return [...new Set([...t.matchAll(LANDED), ...t.matchAll(PUSHED)].map((m) => m[1].slice(0, 7)))];
}

/**
 * What one commit run's result says. MEASURED on a real 460 MB session (784 commit runs): 732 used `git commit -q`, which
 * prints NOTHING on success, so "no SHA" cannot mean "failed". Three states, never two:
 *   'landed'      git printed the SHA (or a push of it)
 *   'not-landed'  the tool reported an error, or git said there was nothing to commit / a hook refused
 *   'unconfirmed' it ran without error and printed no SHA (a quiet commit) — likely landed; git confirms by time
 */
export function commitOutcome(output, isError) {
  const shas = landedShas(output);
  if (shas.length) return { state: 'landed', shas };
  if (isError === true || NOT_LANDED.test(String(output || ''))) return { state: 'not-landed', shas: [] };
  return { state: 'unconfirmed', shas: [] };
}

/**
 * Feed every transcript record in order; read `markers()` at the end.
 * A marker: { ts, state: 'landed'|'not-landed'|'unconfirmed', landed, shas: [short sha], repo: folder name | null }.
 */
export function createCommitCollector() {
  const pending = new Map();   // tool_use id -> { ts, repo }
  const out = [];
  return {
    see(j) {
      if (!j || j.isSidechain === true) return;                 // a subagent's own commits belong to its own transcript
      const content = j.message && Array.isArray(j.message.content) ? j.message.content : null;
      if (!content) return;
      if (j.message.role === 'assistant') {
        for (const b of content) {
          if (!b || b.type !== 'tool_use' || !b.id) continue;
          const cmd = b.input && (typeof b.input.command === 'string' ? b.input.command : null);
          if (cmd && isCommitCommand(cmd)) pending.set(b.id, { ts: j.timestamp || null, repo: repoHintOf(cmd) });
        }
      } else if (j.message.role === 'user') {
        for (const b of content) {
          if (!b || b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
          const call = pending.get(b.tool_use_id);
          pending.delete(b.tool_use_id);
          const o = commitOutcome(textOfResult(b.content), b.is_error);
          out.push({ ts: call.ts || j.timestamp || null, state: o.state, landed: o.state === 'landed', shas: o.shas, repo: call.repo });
        }
      }
    },
    /** Calls still without a result are left out: the turn is still running, and the next capture will see them. */
    markers() { return out.slice(); }
  };
}

/** exchange index -> markers, each given to the last exchange already asked when it ran (as the C1 time join does). */
export function bucketMarkers(exchanges, markers) {
  const idx = [];
  (exchanges || []).forEach((e, i) => { const t = e.ts ? new Date(e.ts).getTime() : NaN; if (Number.isFinite(t)) idx.push({ i, t }); });
  idx.sort((a, b) => a.t - b.t);
  const buckets = new Map();
  for (const m of markers || []) {
    const at = m.ts ? new Date(m.ts).getTime() : NaN;
    if (!Number.isFinite(at)) continue;
    let owner = null;
    for (const e of idx) { if (e.t <= at) owner = e.i; else break; }
    if (owner === null) continue;
    if (!buckets.has(owner)) buckets.set(owner, []);
    buckets.get(owner).push(m);
  }
  return buckets;
}
