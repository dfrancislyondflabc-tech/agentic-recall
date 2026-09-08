#!/usr/bin/env node
// scripts/audit-child-windows-hide.mjs — no child process starts without `windowsHide`.
//
//   node scripts/audit-child-windows-hide.mjs          # this tree; exit 0 clean, 4 with findings
//   node scripts/audit-child-windows-hide.mjs <dir>    # a staged release tree
//
// 🟥 WHY THIS EXISTS (MEM-83). On Windows, `child_process` allocates a NEW CONSOLE WINDOW for a
// child unless the call passes `windowsHide: true`. `lib/scheduler.js` passed it, with a comment
// saying why — and the Windows tester still had console windows flashing on his desktop all day,
// because hiding a parent does not hide its grandchildren: the walker's `spawnSync(auto-ingest)`
// and auto-ingest's `execFileSync(ingest-transcript)` did not pass it, and the Stop hook runs the
// second of those on EVERY assistant response. 3 of 28 launch sites had the option. He called it
// the single most annoying thing about the install.
//
// The one-line lesson: A RULE WITHOUT ENFORCEMENT IS THE DEFECT. Everything after the helper is
// this file, because the next launch site is written by someone who has not read the helper.
//
// HOW IT DECIDES. To start a process a file must first IMPORT one, so the scan is anchored on the
// import rather than on a call-name regex (which would have to guess whether `exec(` is
// child_process or `RegExp.prototype.exec`, and would have guessed wrong 40 times in this tree):
//
//   1. find every `node:child_process` import — static, dynamic, destructured, aliased;
//   2. for each name it binds (`spawnSync`, `spawn`, `execFile`, `execFileSync`, `exec`, `execSync`,
//      `fork`), find every CALL of that name and read the call's own argument text;
//   3. the call must contain `windowsHide` — or one of the ALLOWED_SPREADS below, each of which is
//      itself re-asserted by the suite so an allowance cannot go stale.
//
// A file that imports the HELPER (lib/child.js) has no bare import and so has no sites: going
// through the helper is the way to satisfy this checker, and the cheapest way.
//
// COMMENTS AND STRINGS ARE BLANKED FIRST, offsets preserved. Not fastidiousness: this project's
// prose says `spawnSync('zip', …)` in a comment explaining a past defect, and one public test
// ASSEMBLES the pre-fix source as a string to use as its own negative control. A checker that
// reads those as launch sites reports two findings that cannot be fixed, and a checker that
// reports unfixable findings gets switched off.
//
// 🟥 TWO DIFFERENT BLANKINGS, and the first draft of this file had one — which made it report
// ZERO SITES IN THE WHOLE TREE and exit 0. The import SPECIFIER is itself a string, so blanking
// strings before looking for `from 'node:child_process'` blanks the very thing being looked for:
// a perfectly green, perfectly vacuous checker. Bindings are read with COMMENTS blanked only;
// calls are read with comments AND strings blanked. The suite's (a97) counts the sites it finds
// in the real tree and fails if that count is zero, because "clean" and "blind" print the same.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where a launch site may live. Everything a Windows DESKTOP runs is in here. */
export const SCAN_ROOTS = ['lib', 'scripts', 'index.js', 'packaging', 'tools', 'test/public'];

/** The helper is the one file allowed to name `node:child_process`. */
export const HELPER = 'lib/child.js';

const NAMES = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec', 'fork'];

/**
 * Spread expressions that PROVABLY carry `windowsHide: true`, accepted in place of the literal.
 *
 * One entry, and it is pinned: `spawnOptsForKill()` (test/public/kill-tree.mjs) is the options
 * every fault harness spreads to get the platform's `detached`, and it sets `windowsHide` on both
 * branches. The (a97) group asserts THAT — call the function and read the key — so this allowance
 * cannot survive someone moving the option back inside the win32 branch.
 */
export const ALLOWED_SPREADS = ['...spawnOptsForKill()'];

const IMPORT_RE = /(?:import\s+(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*|(?:await\s+)?import\s*\(\s*|require\s*\(\s*)['"]node:child_process['"]/g;
// `const { spawnSync: sp } = await import('node:child_process')` — the bindings sit BEFORE the
// specifier, so the static form's regex cannot see them.
const DESTRUCTURE_RE = /(?:const|let|var)\s*(\{[^}]*\})\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*['"]node:child_process['"]\s*\)/g;

/**
 * Replace comment bodies — and, with `strings`, string bodies — with spaces, keeping length and
 * line breaks so every offset and line number still refers to the original file.
 *
 * @param {string} text
 * @param {{strings?:boolean}} [o]
 * @returns {string} same length, same newlines
 */
export function blankCommentsAndStrings(text, { strings = true } = {}) {
  // 🟥 split(''), NOT [...text]. Spreading a string iterates CODE POINTS, so every emoji in this
  // project's comments collapsed two UTF-16 units into one array slot and every offset after it
  // drifted — the first run reported six findings whose line numbers were 3–4 short and whose
  // `windowsHide` sat just outside the truncated call text. UTF-16 units in, UTF-16 units out.
  const out = text.split('');
  const keep = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') keep(i++); continue; }
    if (c === '/' && d === '*') {
      keep(i); keep(i + 1); i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) keep(i++);
      if (i < text.length) { keep(i); keep(i + 1); i += 2; }
      continue;
    }
    if (strings && (c === "'" || c === '"' || c === '`')) {
      const q = c; keep(i); i++;
      while (i < text.length) {
        if (text[i] === '\\') { keep(i); keep(i + 1); i += 2; continue; }
        if (text[i] === q) { keep(i); i++; break; }
        // A `${…}` inside a template can hold real code, but nothing in this project launches a
        // process from inside an interpolation, and keeping it would need a parser. Blanked, and
        // the suite's negative control proves the checker still fires on ordinary code.
        keep(i); i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** The names a file binds from `node:child_process`; `'*'` for a namespace import. */
export function childProcessBindings(text) {
  const found = new Set();
  const add = (spec) => {
    if (!spec) return;
    if (!spec.startsWith('{')) { found.add('*'); return; }
    for (const part of spec.slice(1, -1).split(',')) {
      const [orig, alias] = part.split(':').map((s) => s.trim());
      if (NAMES.includes(orig)) found.add(alias || orig);
    }
  };
  let m;
  IMPORT_RE.lastIndex = 0; while ((m = IMPORT_RE.exec(text)) !== null) add(m[1]);
  DESTRUCTURE_RE.lastIndex = 0; while ((m = DESTRUCTURE_RE.exec(text)) !== null) add(m[1]);
  return found;
}

/** The text of the call whose `(` is at `open`, parens balanced. */
function callText(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') { depth--; if (depth === 0) return text.slice(open, j + 1); }
  }
  return text.slice(open);
}

/**
 * Every launch site in one file, and whether each is hidden.
 *
 * @param {string} rel  path as it should be reported
 * @param {string} raw  the file's source
 * @returns {Array<{rel:string, line:number, name:string, hidden:boolean, why:string}>}
 */
export function scanText(rel, raw) {
  const rel2 = rel.split('\\').join('/');
  if (rel2 === HELPER) return [];
  // Bindings from the COMMENT-blanked source (the specifier is a string; see the header), calls
  // from the fully blanked one. Both are the same length as `raw`, so a line number from either
  // is a line number in the file.
  const forBindings = blankCommentsAndStrings(raw, { strings: false });
  const text = blankCommentsAndStrings(raw);
  const sites = [];
  for (const name of childProcessBindings(forBindings)) {
    if (name === '*') {
      sites.push({ rel: rel2, line: 1, name: 'import * as child_process',
        hidden: false, why: 'a namespace import hides nothing and cannot be checked call by call' });
      continue;
    }
    // Not preceded by `.`, `$` or a word char: `re.exec(` and `myspawn(` are not this binding.
    const re = new RegExp(`(^|[^\\w.$])${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const open = m.index + m[0].length - 1;
      const args = callText(text, open);
      const spread = ALLOWED_SPREADS.find((s) => args.includes(s)) || null;
      const hidden = /windowsHide\s*:/.test(args) || spread !== null;
      sites.push({ rel: rel2, line: text.slice(0, open).split('\n').length, name,
        hidden, why: hidden ? (spread || 'windowsHide literal') : 'no windowsHide in the call' });
    }
  }
  return sites;
}

const CODE_RE = /\.(?:js|mjs|cjs)$/;

function filesUnder(root, roots = SCAN_ROOTS) {
  const out = [];
  const walk = (p) => {
    for (const e of readdirSync(p).sort()) {
      const f = join(p, e);
      const s = statSync(f);
      if (s.isDirectory()) walk(f);
      else if (CODE_RE.test(e)) out.push(f);
    }
  };
  for (const r of roots) {
    const p = join(root, r);
    let s = null;
    try { s = statSync(p); } catch { continue; }   // a release tree need not hold every root
    s.isDirectory() ? walk(p) : out.push(p);
  }
  return out;
}

/**
 * PRODUCT CODE MUST GO THROUGH THE HELPER — a second, stricter rule, and the one that matters.
 *
 * "Passes windowsHide" is the floor. For anything the user's machine runs (lib/, scripts/,
 * index.js, packaging/, tools/) the requirement is stronger: do not import `node:child_process`
 * at all, import lib/child.js. Otherwise the option is back to being N call sites' business, and
 * that is precisely the state MEM-83 was found in. Tests are exempt: a fault harness spawns to
 * kill, and coupling it to product code would be worse than the literal.
 *
 * @returns {Array<{rel:string, line:number}>} product files still naming node:child_process
 */
export function bareImporters(root, roots = SCAN_ROOTS.filter((r) => r !== 'test/public')) {
  const out = [];
  for (const f of filesUnder(root, roots)) {
    const rel = relative(root, f).split('\\').join('/');
    if (rel === HELPER) continue;
    // An IMPORT STATEMENT, not the mere string — this file's own regexes spell
    // `node:child_process` and a substring test made the checker its own first finding.
    const text = blankCommentsAndStrings(readFileSync(f, 'utf8'), { strings: false });
    if (!childProcessBindings(text).size) continue;
    IMPORT_RE.lastIndex = 0; DESTRUCTURE_RE.lastIndex = 0;
    const m = IMPORT_RE.exec(text) || DESTRUCTURE_RE.exec(text);
    out.push({ rel, line: text.slice(0, m ? m.index : 0).split('\n').length });
  }
  return out;
}

/**
 * Audit a tree.
 *
 * @param {string} root
 * @param {string[]} [roots]
 * @returns {{root:string, files:number, sites:Array, offenders:Array, bare:Array}}
 */
export function auditTree(root, roots = SCAN_ROOTS) {
  const files = filesUnder(root, roots);
  const sites = [];
  for (const f of files) sites.push(...scanText(relative(root, f), readFileSync(f, 'utf8')));
  return { root, files: files.length, sites, offenders: sites.filter((s) => !s.hidden),
    bare: bareImporters(root, roots.filter((r) => r !== 'test/public')) };
}

// pathToFileURL, never a concatenated `file://` — a Windows username with a '#' or a script run
// off a UNC share does not survive the string form (the a80 class guard fails the suite for it).
const RUN_AS_CLI = !!process.argv[1] &&
  (() => { try { return import.meta.url === pathToFileURL(resolve(process.argv[1])).href; } catch { return false; } })();
if (RUN_AS_CLI) {
  const root = resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
  const r = auditTree(root);
  console.log(`scanned ${r.files} file(s) under ${SCAN_ROOTS.join(', ')} in ${root}`);
  console.log(`${r.sites.length} child-process launch site(s), ${r.sites.length - r.offenders.length} hidden`);
  for (const o of r.offenders) console.log(`  POPUP  ${o.rel}:${o.line}  ${o.name}() — ${o.why}`);
  for (const b of r.bare) console.log(`  BARE   ${b.rel}:${b.line}  imports node:child_process — use ${HELPER}`);
  const bad = r.offenders.length + r.bare.length;
  if (!bad) console.log(`clean: every launch site passes windowsHide, and no product file imports node:child_process (MEM-83)`);
  process.exit(bad ? 4 : 0);
}
