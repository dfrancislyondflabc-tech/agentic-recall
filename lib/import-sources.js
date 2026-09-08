// lib/import-sources.js — turn somebody else's files into memory documents.
//
// ONE implementation, shared by the CLI (scripts/import-memories.js) and the MCP
// `import` action. Two copies of a reader is how the trace endpoint ended up five
// fixes behind the scorer it was supposed to explain, so there is exactly one here.
//
// FORMAT SUPPORT COSTS NO NEW DEPENDENCIES. macOS ships `textutil` (rtf, doc,
// docx, odt, html) and most machines have `pdftotext`; archives are read IN-PROCESS
// by lib/zip.js (node:zlib), because `unzip` is absent on a stock Windows box and
// its absence used to cost two whole import shapes there.
// Where a converter is missing the file is REFUSED BY NAME with the reason, never
// imported as the binary garbage that would otherwise land in the corpus and
// poison every search that touches it.

import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, lstatSync, realpathSync } from 'node:fs';
import { join, basename, extname, sep, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSyncHidden, spawnSyncHidden } from './child.js';   // MEM-83: no console window on Windows
import { extractZipTo } from './zip.js';
import { rmDirWithRetry } from './fs-retry.js';
import { log } from './logger.js';

// 🟥 MEM-73 — THE PROBE ITSELF WAS THE macOS ASSUMPTION.
//
// This was:
//
//     execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: '/bin/bash' });
//
// `/bin/bash` does not exist on Windows, so the spawn ENOENTs, the catch fires, and
// EVERY converter reads as missing there whatever is installed — `converterReport()`
// lies, and `.zip` import was refused outright before it ever tried (campaign E,
// finding E-W1). Nothing in the file had a win32 branch.
//
// The fix is one function with no shell at all: `where` on Windows, `which`
// elsewhere, both spawned directly. A shell was never needed — it was how the
// original reached `command -v`, a shell builtin.
//
// `platform` and `spawn` are injectable so the Windows BRANCH is provable on a Mac:
// the suite feeds platform:'win32' and a recorded spawn and asserts the argv, which
// is the only honest test available while the Windows runner is billing-blocked.
export function probeCommandFor(platform = process.platform) {
  return platform === 'win32' ? 'where' : 'which';
}

export function probeBinary(bin, { platform = process.platform, spawn = spawnSyncHidden } = {}) {
  try {
    // `windowsHide: true` is stated HERE as well as in the helper on purpose: `spawn` is
    // injectable (the suite feeds a recorder), and an injected spawn does not go through
    // lib/child.js — so the literal is what keeps the option true on the path a test sees.
    const r = spawn(probeCommandFor(platform), [bin], { stdio: 'ignore', shell: false, windowsHide: true });
    if (!r || r.error) return false;
    return r.status === 0;
  } catch { return false; }
}

const has = (bin) => probeBinary(bin);
const TOOLS = { textutil: has('textutil'), pdftotext: has('pdftotext') };

export function converterReport() {
  return {
    platform: process.platform,
    probedWith: probeCommandFor(),
    textutil: TOOLS.textutil, pdftotext: TOOLS.pdftotext,
    // NOT a probe result: archives are read in-process by lib/zip.js, so there is
    // no binary to be missing. Reporting a boolean here would invite the reader to
    // think an absent `unzip` still costs them the format.
    zip: 'read in-process (node:zlib) — no external binary',
    note: 'Formats needing a converter that is missing are refused by name, never imported as binary.'
  };
}

const PLAIN = new Set(['.md', '.markdown', '.txt', '.text', '.log']);
const VIA_TEXTUTIL = new Set(['.rtf', '.rtfd', '.doc', '.docx', '.odt', '.html', '.htm', '.webarchive']);
const TABULAR = new Set(['.csv', '.tsv']);

export function supportedExtensions() {
  return [...PLAIN, ...VIA_TEXTUTIL, ...TABULAR, '.pdf', '.json', '.zip'].sort();
}

function runCapture(bin, argv) {
  return execFileSyncHidden(bin, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

// ---- STRUCTURE RECOVERY ----------------------------------------------------
// The section-doc splitter (lib/section-docs.js) chapters any document with
// >= 20 KB and >= 3 `##` headings — which means the whole "make a book
// retrievable" problem reduces to RECOVERING `##` LINES the source format
// already implies. Measured winner per the plan's research: structure-aware
// beats fixed and semantic chunking for manuals, and the anchors double as
// citations ("## p.37" is a page a human can open).

/**
 * pdftotext emits form-feed (\f) page breaks. Convert them to `## p.N`
 * headings so a PDF arrives pre-chaptered with PAGE-ANCHORED provenance —
 * N is the physical page index, so a citation can be checked against the
 * actual PDF. A single-page extraction is returned untouched.
 */
export function pdfPagesToHeadings(text) {
  const pages = String(text || '').split('\f');
  if (pages.length < 2) return String(text || '');

  // RUNNING HEADERS ARE NOISE, NOT CONTENT. pdftotext repeats the page header
  // ("ACME-x73A User Guide") and footer on every page, which hands every page
  // section the same high-frequency terms — measured: the model name appeared
  // on all 68 pages of a real manual, so the one page that actually ANSWERS a
  // model-name question had no lexical edge over the 67 that merely carry the
  // header. Detection is positional and conservative: an exact line repeated in
  // the FIRST or LAST two lines of more than half the pages is a running
  // header/footer and is dropped everywhere; body text never repeats like that.
  const trimmedPages = pages.map((p) => p.split('\n').map((l) => l.trim()));
  const edgeCounts = new Map();
  let nonEmptyPages = 0;
  for (const lines of trimmedPages) {
    const body = lines.filter(Boolean);
    if (!body.length) continue;
    nonEmptyPages++;
    for (const l of new Set([...body.slice(0, 2), ...body.slice(-2)])) {
      if (l.length > 80) continue;
      edgeCounts.set(l, (edgeCounts.get(l) || 0) + 1);
    }
  }
  const running = new Set([...edgeCounts.entries()]
    .filter(([, n]) => nonEmptyPages >= 4 && n > nonEmptyPages / 2)
    .map(([l]) => l));

  const out = [];
  pages.forEach((page, i) => {
    const kept = page.split('\n').filter((l) => !running.has(l.trim()));
    const t = kept.join('\n').trim();
    if (!t) return;                       // a blank page earns no heading, but keeps its number
    out.push(`## p.${i + 1}\n\n${t}`);
  });
  return out.join('\n\n');
}

/**
 * A plain-text book has structure too — Gutenberg texts carry `CHAPTER 12.` /
 * `Chapter IV.` lines — it is just not spelled `##`. Promote those lines,
 * CONSERVATIVELY: only short bare lines matching the chapter shapes, only in a
 * document that has no markdown headings of its own, and only when at least 3
 * promotions result (the splitter needs 3, and one or two "matches" in a
 * document are likelier to be false positives than a table of contents).
 */
const CHAPTER_LINE_RE = /^\s{0,3}((?:CHAPTER|Chapter|BOOK|Book|PART|Part|VOLUME|Volume|ACT|Canto)\s+(?:[0-9]+|[IVXLCDM]+|[A-Z][a-z]+)\b\.?[^\n]{0,60})\s*$/;
export function promoteChapterHeadings(text) {
  const src = String(text || '');
  if (/^##?#?\s+\S/m.test(src)) return src;          // real markdown headings win
  const lines = src.split('\n');
  // A designator that appears TWICE is a table of contents plus the chapter
  // itself. Promote only the LAST occurrence: promoting both turned Gutenberg's
  // ToC into 135 sub-200-byte sections (harmlessly filtered) PLUS one junk
  // section anchored on the final ToC line that swallowed the whole front
  // matter under the wrong chapter's name. The ToC stays plain text; the front
  // matter stays with the document head, where it belongs.
  const designator = (m) => m[1].match(/^\S+\s+\S+/)[0].replace(/\.$/, '').toUpperCase();
  const lastIndex = new Map();
  lines.forEach((line, i) => {
    const m = CHAPTER_LINE_RE.exec(line);
    if (m) lastIndex.set(designator(m), i);
  });
  let hits = 0;
  const promoted = lines.map((line, i) => {
    const m = CHAPTER_LINE_RE.exec(line);
    if (!m || lastIndex.get(designator(m)) !== i) return line;
    hits++;
    return `## ${m[1].trim()}`;
  });
  return hits >= 3 ? promoted.join('\n') : src;
}

/**
 * Minimal HTML -> markdown-ish text: <h1>-<h6> become #-headings (the whole
 * point — textutil's txt conversion flattens headings into indistinguishable
 * lines), block elements become paragraph breaks, everything else is stripped,
 * basic entities decoded. Not a general HTML parser and not trying to be one.
 */
export function htmlToMarkdownish(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`);
  t = t.replace(/<\/(p|div|li|tr|table|ul|ol|blockquote|section|article)>/gi, '\n\n');
  t = t.replace(/<(br|hr)\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'");
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text of one file, or { skip: reason } — never binary, never a guess. */
export function textOf(file, { structure = false } = {}) {
  const ext = extname(file).toLowerCase();
  try {
    if (PLAIN.has(ext)) {
      const text = readFileSync(file, 'utf8');
      // Chapter promotion is opt-in (category imports): a three-line curated
      // note must never come back rewritten because a word matched a regex.
      return { text: structure ? promoteChapterHeadings(text) : text };
    }
    if (TABULAR.has(ext)) {
      // A spreadsheet of notes is still notes. Keep it as text rather than
      // inventing a row-to-memory mapping nobody asked for.
      return { text: readFileSync(file, 'utf8') };
    }
    if (ext === '.html' || ext === '.htm') {
      // The headings are RIGHT THERE in the source; going through textutil's
      // txt conversion erases them. Structure mode reads the file directly.
      if (structure) {
        const md = htmlToMarkdownish(readFileSync(file, 'utf8'));
        if (md.length > 40) return { text: md };
      }
      // HTML IS TEXT, so it must not need a macOS binary. textutil ships only with macOS, and
      // outside structure mode this fell straight through to it: `.html` is in the documented
      // format list, imported fine on the author's Mac, and was silently SKIPPED on Linux and
      // Windows. Caught by CI on 2026-09-05, after the macOS-only run had passed.
      //
      // The direct reader is used here only as the FALLBACK, not as the new default, so macOS
      // behaviour is unchanged: structure mode still reads the file directly for its headings,
      // and plain mode still prefers textutil's txt conversion, which deliberately flattens them.
      if (!TOOLS.textutil) {
        const md = htmlToMarkdownish(readFileSync(file, 'utf8'));
        if (md.length > 40) return { text: md };
        return { skip: `could not read ${ext} without textutil (macOS), and the markup yielded no text` };
      }
      return { text: runCapture('textutil', ['-convert', 'txt', '-stdout', file]) };
    }
    if (VIA_TEXTUTIL.has(ext)) {
      if (!TOOLS.textutil) return { skip: `needs textutil (macOS) to read ${ext}` };
      if (structure) {
        // docx/odt/rtf keep their heading levels through the HTML conversion
        // and lose them through txt — recover them, and fall back to txt when
        // the document yields nothing that way.
        try {
          const md = htmlToMarkdownish(runCapture('textutil', ['-convert', 'html', '-stdout', file]));
          if (md.length > 40) return { text: md };
        } catch (_) { /* fall through to the txt path */ }
      }
      return { text: runCapture('textutil', ['-convert', 'txt', '-stdout', file]) };
    }
    if (ext === '.pdf') {
      if (!TOOLS.pdftotext) return { skip: 'needs pdftotext to read .pdf — convert it first, or install poppler' };
      // Page headings are NOT gated on structure mode: a form feed in a memory
      // body is garbage in every destination, and `## p.N` is the provenance
      // a PDF citation needs anywhere it lands.
      return { text: pdfPagesToHeadings(runCapture('pdftotext', ['-q', file, '-'])) };
    }
    return { skip: `unsupported format ${ext || '(no extension)'}` };
  } catch (e) {
    return { skip: `could not read: ${String(e.message || e).split('\n')[0].slice(0, 80)}` };
  }
}

/** ChatGPT export: conversations.json is an array; each has a `mapping` TREE. */
export function readChatGptExport(jsonPath) {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const convos = Array.isArray(raw) ? raw : (raw.conversations || []);
  const out = [];
  for (const c of convos) {
    const mapping = c.mapping || {};
    // Ordered by create_time, not insertion order: a branched conversation has no
    // single linear list, and the tree is the only thing that knows the sequence.
    const msgs = Object.values(mapping)
      .map((nd) => nd && nd.message)
      .filter((m) => m && m.content && (!m.author || m.author.role !== 'system'))
      .map((m) => ({
        role: (m.author && m.author.role) || 'unknown',
        time: m.create_time || 0,
        text: Array.isArray(m.content.parts)
          ? m.content.parts.filter((x) => typeof x === 'string').join('\n')
          : (typeof m.content === 'string' ? m.content : '')
      }))
      .filter((m) => m.text && m.text.trim())
      .sort((a, b) => (a.time || 0) - (b.time || 0));
    if (!msgs.length) continue;
    out.push({
      title: c.title || 'untitled conversation',
      when: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
      body: msgs.map((m) => `**${m.role === 'user' ? 'Asked' : 'Answered'}:** ${m.text.trim()}`).join('\n\n'),
      source: 'chatgpt'
    });
  }
  return out;
}

// A raw-text file over 5 MB is a data dump, not notes. A CONVERTER format gets
// a far higher bar because its on-disk size is binary, not text: a 15 MB
// hardware-manual PDF extracts to well under 2 MB of text, and refusing it by
// the binary size was exactly how the first manual import failed.
const PLAIN_SIZE_CAP = 5 * 1024 * 1024;
const BINARY_SIZE_CAP = 64 * 1024 * 1024;
const sizeCapFor = (ext) => (PLAIN.has(ext) || TABULAR.has(ext) ? PLAIN_SIZE_CAP : BINARY_SIZE_CAP);

/** Anything else: walk a folder (recursively) or read one file. */
/**
 * Does `candidate` leave `rootDir` once symlinks are resolved?
 *
 * 🟥 ONE HELPER, USED BY EVERY DOOR — and it took three doors to learn that. The walker was
 * fixed first; then a zip whose `conversations.json` is a SYMLINK turned out to be read by
 * readSource BEFORE the walker ever runs, so the guard was simply not on that path. It imported a
 * file from outside the archive, title and all. A boundary enforced in one place is a boundary;
 * enforced in two places it is a coincidence.
 *
 * lstat first: only a symlink can escape, and resolving every plain file would cost a syscall per
 * entry for nothing. An unresolvable path is refused rather than guessed at.
 */
export function escapesRoot(candidate, rootDir) {
  let realRoot;
  try { realRoot = realpathSync(rootDir); } catch { return false; }
  try {
    if (!lstatSync(candidate).isSymbolicLink()) return false;
    const real = realpathSync(candidate);
    return !(real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep));
  } catch {
    return true;
  }
}

export function readFilesAt(p, { maxDepth = 4, structure = false } = {}) {
  const items = [];
  const skipped = [];
  // 🟥 THE SOURCE ROOT IS A BOUNDARY, AND A SYMLINK MAY NOT CROSS IT.
  //
  // doImport's own comment promises it "reads ONLY the path given". That was false: `unzip`
  // restores stored SYMLINKS, and this walker followed them. A zip containing
  // `sub/link.md -> /etc/hosts` imported the machine's /etc/hosts as a memory; pointed at
  // ~/.ssh/config or ~/.aws/credentials it would import those. The recorded `sourcePath` was the
  // temp extraction directory, so nothing in the corpus showed the content came from off-archive.
  // The threat is ordinary — "here are my notes, import them" — and the credential screen is a
  // filter, not a boundary.
  //
  // A folder import had the same hole. Both are closed here, at the walk, because that is the one
  // place every source funnels through.
  const escapes = (full) => escapesRoot(full, p);
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;                       // .git, .DS_Store, dotfiles
      const full = join(dir, e);
      if (escapes(full)) { skipped.push({ file: e, why: 'symlink pointing outside the source' }); continue; }
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (depth < maxDepth) walk(full, depth + 1); continue; }
      const cap = sizeCapFor(extname(full).toLowerCase());
      if (st.size > cap) { skipped.push({ file: e, why: `over ${Math.round(cap / 1024 / 1024)} MB` }); continue; }
      const r = textOf(full, { structure });
      if (r.skip) { skipped.push({ file: e, why: r.skip }); continue; }
      const text = (r.text || '').trim();
      if (!text) { skipped.push({ file: e, why: 'no readable text' }); continue; }
      const h1 = text.match(/^#\s+(.+)$/m);
      items.push({
        title: (h1 && h1[1].trim()) || basename(full, extname(full)).replace(/[-_]+/g, ' '),
        when: new Date(st.mtimeMs).toISOString(),
        body: text,
        source: extname(full).toLowerCase().replace('.', '') || 'file',
        sourcePath: full,
        bytes: st.size
      });
    }
  };
  const st = statSync(p);
  if (st.isDirectory()) walk(p, 0);
  else {
    const r = textOf(p, { structure });
    if (r.skip) skipped.push({ file: basename(p), why: r.skip });
    else {
      const text = (r.text || '').trim();
      const h1 = text.match(/^#\s+(.+)$/m);
      items.push({ title: (h1 && h1[1].trim()) || basename(p, extname(p)).replace(/[-_]+/g, ' '),
                   when: new Date(st.mtimeMs).toISOString(), body: text,
                   source: extname(p).toLowerCase().replace('.', '') || 'file',
                   sourcePath: p, bytes: st.size });
    }
  }
  return { items, skipped };
}

/** Detect what a path is and read it. Returns { shape, items, skipped }. */
export function readSource(p, opts = {}) {
  const st = statSync(p);
  const ext = extname(p).toLowerCase();

  if (!st.isDirectory() && ext === '.zip') {
    // 🟥 NO EXTERNAL BINARY, BY CONSTRUCTION (MEM-73). This used to be
    // `if (!TOOLS.unzip) return … 'needs unzip'` followed by `execFileSync('unzip', …)`,
    // which refused every archive on a stock Windows box. lib/zip.js reads the
    // central directory and inflates with node:zlib, RESTORES stored symlinks
    // exactly as `unzip` did — so the escapesRoot() guard below still sees, and
    // still refuses, the off-archive ones — and refuses an entry NAME that
    // escapes the destination, which `unzip` used to be doing for us.
    // 🟥 MEM-76 — THE EXTRACTION IS DELETED ON EVERY EXIT PATH. Before this, the temp directory
    // was created and never removed: three imports left three `mem-import-*` trees holding a
    // CLEARTEXT copy of every file in every archive, forever, and the shipped public suite alone
    // left five before a user imported anything (Windows acceptance of 1.7.2, F6 — measured
    // 0 → 5 after a plain `run-public-tests.js`, then +1 per import, `mem-import-piFBnj` holding
    // a.md/b.md/c.md in the clear). Nothing outside this block needs the tree: every item's `body`
    // is read eagerly below, so the only thing that survived was the copy itself. The removal is a
    // `finally`, so the bad-archive path cleans up too, and it uses the Windows retry — a scanner
    // holding a handle is a housekeeping cost, never a reason to fail an import.
    const tmp = mkdtempSync(join(tmpdir(), 'mem-import-'));
    try {
      let unpackSkipped = [];
      try { unpackSkipped = extractZipTo(p, tmp).skipped; }
      catch (e) { return { shape: 'zip', items: [], skipped: [{ file: basename(p), why: 'could not unzip: ' + e.message }] }; }
      const conv = join(tmp, 'conversations.json');
      // The SAME boundary as the walker below. This read happens first, so without it the zip's
      // conversations.json could be a symlink to any JSON on the machine — and it was: a zip
      // containing `conversations.json -> <some file>.json` imported that file's contents as
      // conversations, title and all.
      if (existsSync(conv)) {
        if (escapesRoot(conv, tmp)) {
          return { shape: 'zip', items: [],
            skipped: [...unpackSkipped, { file: 'conversations.json', why: 'symlink pointing outside the archive' }] };
        }
        return { shape: 'ChatGPT export (zip)', items: readChatGptExport(conv), skipped: unpackSkipped };
      }
      const r = readFilesAt(tmp, opts);
      // The recorded provenance must outlive the tree that is about to be deleted. A
      // `/var/folders/…/mem-import-XXXX/notes.md` in a memory's frontmatter named a path that
      // existed for the duration of one function call; `<archive>!<entry>` names the thing the
      // user actually handed us and is still true tomorrow.
      const items = r.items.map((it) => (it.sourcePath && it.sourcePath.startsWith(tmp)
        ? { ...it, sourcePath: `${p}!${relative(tmp, it.sourcePath).split(sep).join('/')}` }
        : it));
      return { shape: 'zip of files', ...r, items, skipped: [...unpackSkipped, ...r.skipped] };
    } finally {
      // A leaked temp directory is a privacy cost; a throw here would cost the caller the import
      // it already completed. Log-and-carry-on is the contract lib/fs-retry.js documents.
      try { rmDirWithRetry(tmp); }
      catch (e) { try { log(`import: could not remove ${tmp} (${e.code || e.message}) — extracted copy left behind`); } catch (_) { /* logging is not worth a throw either */ } }
    }
  }

  if (!st.isDirectory() && ext === '.json') {
    // conversations.json, or any JSON we can recognise as an export.
    try {
      const items = readChatGptExport(p);
      if (items.length) return { shape: 'ChatGPT export (conversations.json)', items, skipped: [] };
    } catch { /* fall through and treat it as a text file */ }
    const r = readFilesAt(p, opts);
    return { shape: 'JSON (read as text — not a recognised export)', ...r };
  }

  const r = readFilesAt(p, opts);
  return { shape: st.isDirectory() ? 'folder of files' : 'single file', ...r };
}
