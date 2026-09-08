#!/usr/bin/env node
// scripts/stamp-memory-account.js — put the signed-in account on a memory file
// that does not already name one.
//
//   node scripts/stamp-memory-account.js <file.md>
//
// WHY A HOOK AND NOT A CONVENTION. Auto-captured exchanges are stamped by the
// extractor, because the extractor writes them. CURATED memories are written by
// Claude with an ordinary file tool that never goes through this server, so
// nothing stamps those — the label depended on whoever was writing remembering
// to add it, and a rule that depends on remembering is a rule that decays.
//
// Only ever ADDS. If a memory already names an account that stands, including
// when it names a different one: re-attributing somebody else's memory to
// whoever happens to edit it next is the exact "attribution follows the reader"
// mistake this field exists to avoid.
//
// Silent and non-fatal by design: it runs on every memory write, and a stamping
// failure must never be able to lose the memory itself.

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { rewriteFrontmatterOnly } from '../lib/safe-write.js';
import { basename } from 'node:path';
import { accountLabel } from '../lib/config.js';
import { redact } from '../lib/secrets.js';

/**
 * The edited file path, from argv OR from the hook's own JSON on stdin.
 *
 * The hook used to pipe jq into a POSIX `case` that matched the memory path glob
 * before calling this script. jq, the pipe and `case` are all POSIX-only, so none
 * of it exists on Windows. (That glob cannot be written in this comment: it ends
 * in the two characters that close a block comment, which is exactly how the
 * first version of this file turned its own documentation into a syntax error.)
 * Reading stdin here makes
 * the hook a bare `node stamp-memory-account.js`, identical on both platforms, and
 * the path filtering moves into the guard below, which this script already had.
 */
let HOOK = null;
function filePathFromStdin() {
  try {
    if (process.stdin.isTTY) return undefined;
    const raw = readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return undefined;
    const j = JSON.parse(raw);
    HOOK = j;   // session_id and transcript_path ride along; see originTask below
    return j?.tool_input?.file_path || j?.tool_response?.filePath || undefined;
  } catch (_) { return undefined; }
}

/**
 * The instruction that was in force when this memory was written.
 *
 * 🟥 WHY THIS FIELD EXISTS. A directive given to ONE session — roughly "use the memory server to
 * help you with the job in front of you; if you find problems in it, just log them and carry on" —
 * was captured as a STANDING RULE. A later session that had been pointed AT the memory server read
 * it and refused to do the work it had just been asked for. Nothing in the memory recorded who the
 * instruction was aimed at, so every future reader inherited it as universal.
 *
 * A session TITLE was considered and measured: it is only joinable for 74 of 115 memories, and it
 * describes a session's FIRST message — useless on a 776-exchange session where the rule was
 * captured at exchange 500. The last user message before the write is the actual context, and it
 * is available here for free.
 *
 * Reads only the TAIL of the transcript: these files reach 11 MB, and this runs on every memory
 * write. Redacted through the same guard as everything else, and truncated — this is a label, not
 * a record.
 */
function originTask() {
  try {
    const path = HOOK?.transcript_path;
    if (!path) return null;
    const size = statSync(path).size;
    // 🟥 1 MB, NOT 256 KB, AND THE REASON IS MEASURED. A busy turn fills the transcript with tool
    // traffic: on a real 15.7 MB transcript the last 256 KB contained NO human message at all —
    // every `type:"user"` line in it was a tool_result. The first version of this function
    // therefore returned null in production while passing its own synthetic test, which is
    // exactly the failure a synthetic test cannot show you.
    const want = Math.min(size, 1024 * 1024);
    const fd = openSync(path, 'r');
    let raw;
    try {
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      raw = buf.toString('utf8');
    } finally { closeSync(fd); }
    const lines = raw.split('\n');
    const trim = (t) => {
      const clean = redact(String(t)).text.replace(/\s+/g, ' ').trim();
      if (!clean) return null;
      return clean.length > 180 ? clean.slice(0, 177) + '…' : clean;
    };
    // PREFERRED: the transcript records the last prompt explicitly. Cheaper and more exact than
    // inferring it, and immune to however message content is shaped in a given client version.
    for (let i = lines.length - 1; i >= 0; i--) {
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      if (j?.type === 'last-prompt' && j.lastPrompt) {
        const t = trim(j.lastPrompt);
        if (t) return t;
      }
    }
    // FALLBACK: the newest human message that is actually text. A `type:"user"` line is usually a
    // TOOL RESULT — content is an array of {type:'tool_result'} — so filtering to type:'text' is
    // what separates a person from the machinery.
    for (let i = lines.length - 1; i >= 0; i--) {
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      if (j?.type !== 'user') continue;
      const c = j?.message?.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
      const t = String(text || '').trim();
      // Injected reminders are not what anyone asked for.
      if (!t || t.startsWith('<') || t.startsWith('[')) continue;
      const out = trim(t);
      if (out) return out;
    }
  } catch (_) { /* a label is never worth failing a write for */ }
  return null;
}

const file = process.argv[2] || filePathFromStdin();
if (!file || !file.endsWith('.md')) process.exit(0);

// SCOPE THE SCRIPT ITSELF, not just the hook that calls it. The hook filters by
// path, so a HAND-RUN of this script had no guard at all — and promptly stamped
// account frontmatter onto a handoff document that is not a memory. A tool that
// edits files must carry its own precondition, because the caller that enforced
// it will not always be the caller.
// BOTH SEPARATORS. Windows hands this "C:\\Users\\me\\.claude\\projects\\x\\memory\\y.md",
// which a forward-slash-only pattern never matches -- so the guard would reject
// every real memory and stamping would silently never happen on that platform.
const looksLikeMemoryPath = (f) =>
  /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/.test(f) ||
  /[\\/]store[\\/]/.test(f) && /[\\/](agentic-recall|recall-mcp|memory-mcp-server)[\\/]/.test(f) ||
  process.env.MEMORY_STAMP_ANY === '1';
if (!looksLikeMemoryPath(file)) process.exit(0);
if (basename(file) === 'MEMORY.md') process.exit(0);   // the shared index belongs to nobody

const account = accountLabel();
if (!account) process.exit(0);

let s;
try { s = readFileSync(file, 'utf8'); } catch { process.exit(0); }

// EVERY MISSING FIELD, NOT JUST THE FIRST. This used to exit the moment an account was present,
// which meant a memory written before a field existed could never gain it. Each field keeps the
// original discipline separately: only ever ADDED, never overwritten.
const want = [];
if (!/^\s+account:/m.test(s)) want.push(['account', account]);
if (!/^\s+originSessionId:/m.test(s) && HOOK?.session_id) want.push(['originSessionId', HOOK.session_id]);
if (!/^\s+originTask:/m.test(s)) {
  const task = originTask();
  if (task) want.push(['originTask', JSON.stringify(task)]);
}
if (!want.length) process.exit(0);
const block = want.map(([k, v]) => `  ${k}: ${v}`).join('\n');

const name = basename(file, '.md');
let out;
if (s.startsWith('---')) {
  const end = s.indexOf('\n---', 3);
  if (end === -1) process.exit(0);                     // malformed; do not touch it
  let fm = s.slice(0, end), rest = s.slice(end);
  if (/^metadata:\s*$/m.test(fm)) fm = fm.replace(/^metadata:[ \t]*$/m, `metadata:\n${block}`);
  else if (/^metadata:/m.test(fm)) fm = fm.replace(/^metadata:.*$/m, (m) => `${m}\n${block}`);
  else fm = `${fm}\nmetadata:\n${block}`;
  out = fm + rest;
} else {
  out = `---\nname: ${name}\nmetadata:\n${block}\n---\n\n${s}`;
}
// Through the guarded writer: body-identical or refused, snapshot first, atomic, and inert under
// MEMORY_CURATED_READ_ONLY=1 (this is the one writer that fires on EVERY Write/Edit of a memory file).
try {
  const w = rewriteFrontmatterOnly(file, out, { allowNewFrontmatter: true });
  console.error(w.written ? `[stamp] ${name} -> ${want.map(([k]) => k).join(', ')}` : `[stamp] ${name} not written: ${w.refused}`);
} catch { /* never fail a write */ }
