#!/usr/bin/env node
// scripts/import-memories.js — bring someone else's memories in.
//
// This server was built for one person's software project. The friend who tries it
// next may be planning a novel, or a business, and their history may live in a
// ChatGPT export rather than a Claude transcript. None of that should require them
// to understand corpora, indexes or frontmatter.
//
//   node scripts/import-memories.js <path> [--dry] [--domain writing] [--name mine]
//
// <path> may be:
//   * a ChatGPT export .zip or its conversations.json
//   * a folder of .md / .txt notes (Obsidian, Notion export, plain files)
//   * a single .md / .txt file
//
// What it does, in order: detect the shape, convert each conversation or note into
// one memory document, DERIVE what kind of corpus it is, then tell the user the two
// commands that finish the job. --dry changes nothing and prints the same report,
// because the first thing anyone should be able to do with an importer is see what
// it WOULD do.
//
// Design rules this follows, each learned the hard way in this repo:
//   * never write outside the memory root
//   * never overwrite an existing memory (a re-run is safe)
//   * skip nothing silently — every skipped item is counted and named
//   * a credential-shaped line is refused, not imported (see lib/secrets.js policy)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname, resolve } from 'node:path';
import { execFileSyncHidden } from '../lib/child.js';   // MEM-83: no console window on Windows
import { memoryDir } from '../lib/config.js';
import { deriveProfile } from '../lib/corpus-profile.js';
import { readSource } from '../lib/import-sources.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const argOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const SRC = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--domain'
  && args[args.indexOf(a) - 1] !== '--name' && args[args.indexOf(a) - 1] !== '--out');
const DOMAIN = argOf('--domain');
const PREFIX = (argOf('--name') || 'imported').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
const OUT = argOf('--out') || memoryDir();

// UNKNOWN FLAGS ARE REFUSED, never ignored. `--category books` was accepted in silence and
// dropped: the import then filed a 434 KB book into the CURATED corpus, which is exactly what the
// MCP path refuses. A flag the user believed was doing something is worse than no flag at all.
const KNOWN_FLAGS = new Set(['--dry', '--domain', '--name', '--out']);
const unknownFlags = args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) {
  console.error(`unknown option(s): ${unknownFlags.join(', ')}`);
  console.error('usage: node scripts/import-memories.js <path-to-export-or-folder> [--dry] [--domain writing] [--name mine] [--out dir]');
  console.error('');
  console.error('Importing reference material (a book, a manual, a policy) into its own LIBRARY');
  console.error('category is done through the MCP tool, not this script:');
  console.error("  memory({ action: 'import', path: '/abs/path', category: 'books' })");
  console.error('That path keeps the material out of your working memories and recovers its');
  console.error('chapter structure on the way in.');
  process.exit(2);
}

if (!SRC) {
  console.error('usage: node scripts/import-memories.js <path-to-export-or-folder> [--dry] [--domain writing] [--name mine] [--out dir]');
  process.exit(2);
}

const slug = (s, n = 60) => String(s || 'untitled').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'untitled';

// Refuse to import a credential. Same shapes lib/git-join.js and the memory
// versioning guard use — a plaintext secret in a corpus is permanent in a way its
// author rarely intends.
const SECRET_RES = [/sshpass\s+-p\s+'[^']+'/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/,
                    /\b(api[_-]?key|password|secret)\s*[:=]\s*['"][^'"]{12,}['"]/i];
const looksSecret = (t) => SECRET_RES.some((re) => re.test(t));

// ---- readers ---------------------------------------------------------------

/** ChatGPT export: conversations.json is an array; each has a `mapping` TREE. */
function readChatGpt(jsonPath) {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const convos = Array.isArray(raw) ? raw : (raw.conversations || []);
  const out = [];
  for (const c of convos) {
    const mapping = c.mapping || {};
    // Walk the tree in create_time order rather than trusting insertion order —
    // a branched conversation has no single linear list.
    const msgs = Object.values(mapping)
      .map((n) => n && n.message)
      .filter((m) => m && m.content)
      .filter((m) => !m.author || m.author.role !== 'system')
      .map((m) => ({
        role: (m.author && m.author.role) || 'unknown',
        time: m.create_time || 0,
        text: Array.isArray(m.content.parts)
          ? m.content.parts.filter((p) => typeof p === 'string').join('\n')
          : (typeof m.content === 'string' ? m.content : '')
      }))
      .filter((m) => m.text && m.text.trim())
      .sort((a, b) => (a.time || 0) - (b.time || 0));
    if (!msgs.length) continue;
    out.push({
      title: c.title || 'untitled conversation',
      when: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
      body: msgs.map((m) => `**${m.role === 'user' ? 'Asked' : 'Answered'}:** ${m.text.trim()}`).join('\n\n')
    });
  }
  return out;
}

// Files a folder walk ignored, so the CLI can SAY so. Silence is the bug this fixes.
let folderSkipped = [];

/**
 * A folder (or single file) of notes.
 *
 * 🟥 ONE READER, NOT TWO. This used to walk the directory itself, filtering
 * `/\.(md|txt|markdown)$/i` and reading with readFileSync — so the CLI the README tells people to
 * run silently ignored every .html, .csv, .rtf, .doc, .docx, .odt and .pdf in the folder, while
 * `memory({action:"import"})` read all of them through lib/import-sources.js. Same product, same
 * documented format list, two different answers, and the CLI did not even count what it dropped:
 * a folder of 3 notes reported "found: 1 item(s)" with no mention of the other two.
 *
 * Measured before the change, on one folder holding note.md, page.html and rules.csv:
 *   lib/import-sources.js readSource() -> 3 items
 *   scripts/import-memories.js         -> found 1
 *
 * Now both go through readSource, which also returns a REASON per skipped file, printed below.
 */
function readNotes(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    const r = readSource(p);
    folderSkipped = r.skipped || [];
    return r.items || [];
  }
  const files = [p];
  return files.map((f) => {
    const text = readFileSync(f, 'utf8');
    // If it already has frontmatter, keep the body and let the title come from the
    // filename — re-wrapping someone's YAML in more YAML helps nobody.
    const parts = text.split('---');
    const body = (text.trimStart().startsWith('---') && parts.length > 2) ? parts.slice(2).join('---') : text;
    const h1 = body.match(/^#\s+(.+)$/m);
    return {
      title: (h1 && h1[1].trim()) || basename(f, extname(f)).replace(/[-_]+/g, ' '),
      when: (() => { try { return new Date(statSync(f).mtimeMs).toISOString(); } catch { return null; } })(),
      body: body.trim()
    };
  });
}

// ---- detect ----------------------------------------------------------------

const src = resolve(SRC);
if (!existsSync(src)) { console.error(`no such path: ${src}`); process.exit(2); }

let items = [];
let shape = '';
if (/\.zip$/i.test(src)) {
  // 🟥 DELEGATED, for two reasons, both found by testing archives on 2026-09-04.
  //
  // 1. IT REJECTED VALID ARCHIVES. This branch unzipped, looked for conversations.json, and if that
  //    file was absent exited with "is it a ChatGPT export?". So a zip of markdown notes — which
  //    the README promises is supported — imported NOTHING through the documented CLI, while
  //    lib/import-sources.js read the same archive as "zip of files, items: 2".
  //
  // 2. IT EXTRACTED WITH ITS OWN `unzip -o`, WITHOUT THE SYMLINK GUARD. unzip restores stored
  //    symlinks; readSource carries a defence added precisely because a zip whose conversations.json
  //    was a SYMLINK got followed. Doing our own extraction here re-opened that door for the CLI.
  //
  // Same lesson as the folder walk: two implementations of one job disagree, and the one people are
  // told to run is the weaker one.
  const r = readSource(src);
  items = r.items || [];
  folderSkipped = r.skipped || [];
  shape = r.shape || 'zip';
} else if (/conversations\.json$/i.test(src)) {
  items = readChatGpt(src); shape = 'ChatGPT export (conversations.json)';
} else if (/\.json$/i.test(src)) {
  try { items = readChatGpt(src); shape = 'JSON export'; }
  catch (e) { console.error('that JSON is not a shape I recognise: ' + e.message); process.exit(2); }
} else {
  items = readNotes(src); shape = statSync(src).isDirectory() ? 'folder of notes' : 'single note';
}

// ---- report + write --------------------------------------------------------

console.log(`\nsource   : ${src}`);
console.log(`shape    : ${shape}`);
console.log(`found    : ${items.length} item(s)`);

// THE SAME GUARD THE MCP PATH ENFORCES. Big or book-shaped content with no category is refused,
// never quietly filed into curated (Daniel's decision, 2026-08-26): one accidental book import
// can dilute working retrieval and plant benchmark terms in the curated corpus. That guard lived
// only in tools/memory.js, so the CLI -- the command the README tells people to run -- imported a
// 434 KB book straight into the memory folder as one undivided document. Measured 2026-09-05.
const IMPORT_UNCATEGORIZED_MAX_BYTES = 200 * 1024;
const BOOK_LIKE_EXTS = new Set(['pdf', 'epub', 'mobi']);
{
  const totalBytes = items.reduce((n, it) => n + (Number(it.bytes) || Buffer.byteLength(String(it.body || ''), 'utf8')), 0);
  const bookLike = items.filter((it) => BOOK_LIKE_EXTS.has(String(it.source || '').toLowerCase()));
  if (totalBytes > IMPORT_UNCATEGORIZED_MAX_BYTES || bookLike.length) {
    const why = bookLike.length
      ? `book-shaped input (${bookLike.length} ${[...BOOK_LIKE_EXTS].join('/')} file(s))`
      : `${Math.round(totalBytes / 1024)} KB of text, over the ${IMPORT_UNCATEGORIZED_MAX_BYTES / 1024} KB limit for an uncategorised import`;
    console.error(`refusing : ${why}.`);
    console.error('');
    console.error('Reference material belongs in its own LIBRARY category, where it is indexed');
    console.error('separately and cannot dilute your working memories. Import it through the MCP');
    console.error('tool, which also recovers its chapter structure on the way in:');
    console.error("  memory({ action: 'import', path: '<this path>', category: 'books' })");
    console.error('');
    console.error('Nothing was written.');
    process.exit(3);
  }
}

const skipped = { empty: 0, secret: [], exists: [] };
const written = [];
const profileInput = [];

// A dry run must change NOTHING, not even an empty directory.
if (!DRY) mkdirSync(OUT, { recursive: true });
let n = 0;
for (const it of items) {
  const text = (it.body || '').trim();
  if (text.length < 40) { skipped.empty++; continue; }
  if (looksSecret(text)) { skipped.secret.push(it.title); continue; }
  n++;
  const name = `${PREFIX}-${String(n).padStart(4, '0')}-${slug(it.title, 48)}`;
  const file = join(OUT, `${name}.md`);
  if (existsSync(file)) { skipped.exists.push(name); continue; }
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(it.title).slice(0, 300)}`,
    'metadata:',
    '  type: imported',
    `  importedFrom: ${JSON.stringify(shape)}`,
    it.when ? `  originalDate: ${it.when}` : null,
    DOMAIN ? `  domain: ${DOMAIN}` : null,
    '---'
    // NOTE: no trailing '' here — .filter(Boolean) would drop it, which is exactly
    // how the first version emitted "---# Title" on one line. The blank line is
    // added explicitly below instead.
  ].filter(Boolean).join('\n');
  profileInput.push({ bodyText: text });
  if (!DRY) writeFileSync(file, `${fm}\n\n# ${it.title}\n\n${text}\n`, 'utf8');
  written.push(name);
}

console.log(`written  : ${DRY ? '(dry run — nothing written) ' : ''}${written.length}`);
if (skipped.empty) console.log(`skipped  : ${skipped.empty} too short to be useful`);
// Say what the WALK ignored, not just what the writer rejected. A file the importer could not read
// is the one thing a person most needs told: it is the difference between "you have no notes about
// X" and "your notes about X are in a format I skipped without mentioning it".
if (folderSkipped.length) {
  console.log(`ignored  : ${folderSkipped.length} file(s) the reader could not use:`);
  for (const s2 of folderSkipped.slice(0, 20)) console.log(`           ${s2.file} — ${s2.why}`);
  if (folderSkipped.length > 20) console.log(`           …and ${folderSkipped.length - 20} more`);
}
if (skipped.secret.length) {
  console.log(`REFUSED  : ${skipped.secret.length} item(s) contain a credential and were NOT imported:`);
  for (const t of skipped.secret.slice(0, 5)) console.log(`             ${JSON.stringify(t)}`);
  console.log('           A plaintext secret in a memory corpus is permanent in a way its author rarely intends.');
}
if (skipped.exists.length) console.log(`skipped  : ${skipped.exists.length} already imported (re-running is safe)`);

const profile = deriveProfile(profileInput, { override: DOMAIN });
console.log(`\ndomain   : ${profile.domain}  (confidence ${profile.confidence}${profile.overridden ? ', you set it' : ', derived by counting'})`);
console.log(`           ${profile.note}`);
if (!DOMAIN && profile.domain !== 'code') {
  console.log('           Counting can only tell code from not-code. If these are notes for a book, a');
  console.log('           business or a research project, re-run with --domain writing|business|research');
  console.log('           (or pass domain: on each query) to get advice written for that work.');
}

// ── finish the job ──────────────────────────────────────────────────────────
//
// Indexing and a first curation pass are not optional extras — an imported corpus
// that has not been indexed is not searchable, and telling a non-coder to "now run
// two more commands" is exactly the step where an import gets abandoned half done.
// So import DOES them, and --no-curate exists for the person who wants to stage the
// files and decide later.
// Auto-curating only makes sense when the files landed where the indexer looks.
// With a custom --out they have not, and running build-index would rebuild the
// REAL corpus while silently leaving the imported one unsearchable — a confident
// "done" over work that did not happen.
const OUT_IS_MEMORY_DIR = resolve(OUT) === resolve(memoryDir());
const CURATE = !args.includes('--no-curate') && OUT_IS_MEMORY_DIR;

console.log('');
if (DRY) {
  console.log('next: re-run without --dry to actually import.\n');
} else if (!written.length) {
  console.log('next: nothing new was imported, so there is nothing to index.\n');
} else if (!CURATE) {
  console.log(OUT_IS_MEMORY_DIR
    ? 'next (you passed --no-curate):'
    : `next (--out is not the memory folder, so indexing it here would not help):`);
  console.log('  1. node scripts/build-index.js          # make them searchable');
  console.log('  2. node scripts/dream.js --force        # first curation pass\n');
} else {
  const run = (label, file, argv) => {
    process.stdout.write(`  ${label} … `);
    try {
      execFileSyncHidden(process.execPath, [join(import.meta.dirname, file), ...argv],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
      console.log('done');
      return true;
    } catch (e) {
      // Never fail the IMPORT because a follow-up step failed — the memories are
      // already written and are the thing that matters.
      console.log('FAILED (the memories are imported; run it yourself)');
      console.log(`     ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
      return false;
    }
  };
  console.log('finishing up:');
  const indexed = run('indexing so they are searchable', 'build-index.js', []);
  if (indexed) run('first curation pass (dream)', 'dream.js', ['--force']);
  console.log('');
  console.log('Now ask Claude something you know is in there, and check it comes back.');
  console.log('If the answer looks wrong, open Edit Alignment on the corpus profile: pass');
  console.log('domain: on a query, or re-import with --domain, and ask again.\n');
}
