#!/usr/bin/env node
// scripts/measure-file-writes.js — the files-at-ingest measurement.
//
//   node scripts/measure-file-writes.js [--min-sessions N] [--min-exchanges N]
//
// THE DECISION RULE WAS FIXED BEFORE THIS SCRIPT EXISTED — see
// test/files-at-ingest-preregistration.md, committed at 8c6577c. This script is
// the instrument, not the judge: it prints the numbers the pre-registered rule
// consumes and decides nothing itself. Same discipline as C1's commit
// measurement: the question is whether the transcript's PROSE names the durable
// files its TOOL CALLS wrote, because prose is all ingest captures.
//
// Reads the most recent qualifying session transcripts (JSONL under
// ~/.claude/projects/*/): each must have >= 20 exchanges (a non-machine user
// turn answered by >= 200 chars of assistant text, mirroring ingest-transcript's
// unit), the pool must span >= 2 project dirs, and there must be >= 8 of them.
// Transcripts are tens of MB, so every file is STREAMED line by line, twice:
// pass 1 collects the durable write paths, pass 2 checks the same session's
// user/assistant TEXT blocks for them. Two passes cost a re-parse; slurping
// costs the machine.
//
// DURABLE WRITE (the pre-registration's list, verbatim): a Write / Edit /
// NotebookEdit tool_use whose file_path is NOT under /tmp, /private/tmp, a
// `scratchpad` path segment, node_modules, .git, a .claude/projects/*/tasks or
// scratchpad dir, or an index/artifact file (.memory-index.json,
// .staging-index.json, *.zip). Deduped per (session, path).
//
// NAMED IN PROSE: the exact path appears in a user or assistant text block of
// the same session — or its basename does, when the basename is >= 12 chars
// AND unambiguous in that transcript (it belongs to exactly one durable path
// there). Matching the tool_use JSON itself would make every write "named",
// which is why only TEXT blocks are searched.

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const argNum = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : (parseInt(process.argv[i + 1]) || dflt);
};
const MIN_SESSIONS = argNum('--min-sessions', 8);
const MIN_EXCHANGES = argNum('--min-exchanges', 20);
const MIN_REPLY_CHARS = 200;      // ingest-transcript's own bar for a real exchange
const MIN_BASENAME = 12;          // below this a basename matches by accident

// ---- the durable-location filter (pre-registered; do not widen or narrow) --
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
function isDurable(p) {
  const path = String(p || '');
  if (!path) return false;
  if (path.startsWith('/tmp/') || path === '/tmp') return false;
  if (path.startsWith('/private/tmp/') || path === '/private/tmp') return false;
  if (/(^|\/)scratchpad(\/|$)/i.test(path)) return false;
  if (/(^|\/)node_modules(\/|$)/.test(path)) return false;
  if (/(^|\/)\.git(\/|$)/.test(path)) return false;
  if (/\/\.claude\/projects\/[^/]+\/(tasks|scratchpad)(\/|$)/.test(path)) return false;
  if (/\.memory-index\.json$|\.staging-index\.json$|\.zip$/i.test(path)) return false;
  return true;
}

// ---- the by-kind buckets ----------------------------------------------------
// Order matters: a memory file and a KB file are both .md, so provenance
// (the folder) is read before the extension.
function kindOf(p) {
  const path = String(p);
  if (/\/knowledge-base\//i.test(path)) return 'kb';
  if (/\/memory\//.test(path) || /\/MEMORY\.md$/.test(path) || /\/\.claude\/.*memory/i.test(path)) return 'memory';
  if (/\.(md|txt|rst)$/i.test(path)) return 'doc';
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|rb|go|rs|c|h|cpp|java|swift|html|css|scss|json|yml|yaml|toml|xml|sql|ipynb)$/i.test(path)) return 'code';
  return 'other';
}

// ---- machine turns (mirrors scripts/ingest-transcript.js) -------------------
const isMachineTurn = (t) => {
  if (!t) return true;
  if (t.includes('<system-reminder>')) return true;
  if (t.includes('<task-notification>')) return true;
  if (t.startsWith('[SYSTEM NOTIFICATION')) return true;
  if (t.startsWith('Caveat: The messages below')) return true;
  if (/^<(command-name|local-command|command-message|bash-input|bash-stdout)/.test(t)) return true;
  const tagChars = (t.match(/<\/?[a-z][a-z0-9-]*>/gi) || []).join('').length;
  if (tagChars > t.length * 0.15) return true;
  return false;
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
};

async function eachLine(file, fn) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    fn(j);
  }
}

// ---- pass 1: exchanges + durable writes ------------------------------------
async function collect(file) {
  const turns = [];          // {role, text} in order, for the exchange count
  const writes = new Map();  // path -> kind   (dedup per session+path)
  let toolWrites = 0;        // raw tool_use count, before dedup/filter
  await eachLine(file, (j) => {
    const role = j.message?.role;
    if (role !== 'user' && role !== 'assistant') return;
    const t = textOf(j.message.content);
    if (t) turns.push({ role, text: t });
    if (role === 'assistant' && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b.type !== 'tool_use' || !WRITE_TOOLS.has(b.name)) continue;
        toolWrites++;
        const p = b.input?.file_path || b.input?.notebook_path;
        if (p && isDurable(p)) writes.set(String(p), kindOf(p));
      }
    }
  });
  let exchanges = 0;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'user' || isMachineTurn(turns[i].text)) continue;
    let reply = 0;
    for (let k = i + 1; k < turns.length && turns[k].role === 'assistant'; k++) reply += turns[k].text.length;
    if (reply >= MIN_REPLY_CHARS) exchanges++;
  }
  return { exchanges, writes, toolWrites };
}

// ---- pass 2: which durable paths does the session's PROSE name? -------------
async function namedInProse(file, paths) {
  // basename -> paths that own it; only an unambiguous basename may match
  const byBase = new Map();
  for (const p of paths) {
    const b = basename(p);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  const named = new Set();
  await eachLine(file, (j) => {
    const role = j.message?.role;
    if (role !== 'user' && role !== 'assistant') return;
    const t = textOf(j.message.content);
    if (!t) return;
    for (const p of paths) {
      if (named.has(p)) continue;
      if (t.includes(p)) { named.add(p); continue; }
      const b = basename(p);
      if (b.length >= MIN_BASENAME && byBase.get(b).length === 1 && t.includes(b)) named.add(p);
    }
  });
  return named;
}

// ---- gather the most recent qualifying transcripts --------------------------
const projectsDir = join(homedir(), '.claude', 'projects');
const candidates = [];
for (const d of readdirSync(projectsDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = join(projectsDir, d.name);
  let files; try { files = readdirSync(dir); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const full = join(dir, f);
    let st; try { st = statSync(full); } catch { continue; }
    candidates.push({ file: full, project: d.name, mtime: st.mtimeMs, size: st.size });
  }
}
candidates.sort((a, b) => b.mtime - a.mtime);

// --allow-single-dir: the pre-registration asks for >= 2 project dirs so the
// sample is not one project's habits. MEASURED ON THIS MACHINE 2026-08-26: the
// requirement is unmeetable — exactly two ~/.claude/projects/* dirs exist, and
// the second holds a single 9-exchange transcript (under the 20-exchange bar).
// The flag waives the DIR-SPREAD precondition only, loudly, so the deviation is
// on the record; the decision thresholds in the pre-registration are untouched.
// (The one populated dir is the catch-all workspace whose sessions span many
// repos — deck builds, the email app, this server — so the spread the clause
// wanted is partly present inside it anyway.)
const ALLOW_SINGLE_DIR = process.argv.includes('--allow-single-dir');
const sessions = [];
const projectsSeen = new Set();
for (const c of candidates) {
  if (sessions.length >= MIN_SESSIONS && (ALLOW_SINGLE_DIR || projectsSeen.size >= 2)) break;
  const { exchanges, writes, toolWrites } = await collect(c.file);
  if (exchanges < MIN_EXCHANGES) continue;
  sessions.push({ ...c, exchanges, writes, toolWrites });
  projectsSeen.add(c.project);
}
if (sessions.length < MIN_SESSIONS || (!ALLOW_SINGLE_DIR && projectsSeen.size < 2)) {
  console.error(`only ${sessions.length} qualifying transcript(s) across ${projectsSeen.size} project dir(s) ` +
    `(need >= ${MIN_SESSIONS} across >= 2) — not enough data, refusing to print a number the rule would consume.` +
    (sessions.length >= MIN_SESSIONS
      ? ' If the machine genuinely has one populated project dir, rerun with --allow-single-dir and RECORD the deviation.'
      : ''));
  process.exit(2);
}
if (ALLOW_SINGLE_DIR && projectsSeen.size < 2) {
  console.log('DEVIATION FROM PRE-REGISTRATION: sample spans 1 project dir (>= 2 required) — waived by --allow-single-dir; record this next to the numbers.\n');
}

// ---- the numbers -------------------------------------------------------------
const KINDS = ['doc', 'code', 'kb', 'memory', 'other'];
const pooled = { durable: 0, named: 0 };
const byKind = Object.fromEntries(KINDS.map((k) => [k, { durable: 0, named: 0 }]));

console.log(`sessions measured: ${sessions.length} across ${projectsSeen.size} project dir(s), newest first\n`);
for (const s of sessions) {
  const paths = [...s.writes.keys()];
  const named = await namedInProse(s.file, paths);
  const silent = paths.length ? (1 - named.size / paths.length) : 0;
  pooled.durable += paths.length; pooled.named += named.size;
  for (const p of paths) {
    const k = s.writes.get(p);
    byKind[k].durable++;
    if (named.has(p)) byKind[k].named++;
  }
  console.log(`${basename(s.file, '.jsonl').slice(0, 8)}  [${s.project.slice(-40).padEnd(40)}]` +
    `  exchanges ${String(s.exchanges).padStart(4)}  raw tool writes ${String(s.toolWrites).padStart(4)}` +
    `  durable ${String(paths.length).padStart(3)}  named ${String(named.size).padStart(3)}` +
    `  silent ${paths.length ? (silent * 100).toFixed(0).padStart(3) + '%' : '  —'}`);
}

const silentShare = pooled.durable ? 1 - pooled.named / pooled.durable : 0;
console.log(`\npooled: durable ${pooled.durable}, named in prose ${pooled.named}, ` +
  `SILENT SHARE ${(silentShare * 100).toFixed(1)}%`);
console.log('\nby kind (durable / named / silent):');
for (const k of KINDS) {
  const v = byKind[k];
  const label = { doc: 'handoff/doc md', code: 'code', kb: 'KB files', memory: 'memory files', other: 'other' }[k];
  console.log(`  ${label.padEnd(15)} ${String(v.durable).padStart(4)} / ${String(v.named).padStart(4)} / ` +
    (v.durable ? ((1 - v.named / v.durable) * 100).toFixed(1) + '%' : '—'));
}
console.log('\nThe rule that consumes these numbers is test/files-at-ingest-preregistration.md — apply it mechanically.');
