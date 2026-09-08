// lib/benchmark-strings.js — the committed benchmark vocabulary, as a set.
//
// THE LOG-SIDE TWIN OF TEST a45. a45 keeps benchmark strings OUT of the corpus
// (writing about a probe silently moves its score); this keeps them out of the
// TRAFFIC statistics. Measured on the frozen 2026-08-26/27 window: 58% of
// "live" rows were our own gold/eval/probe strings, because anything driven
// through the real tool handler — eval:state, the library gold scorer, a
// measurement harness — earns src:'live' honestly. The tag says HOW the call
// arrived; this set says WHAT was asked. Both are needed to call a row
// genuine.
//
// The set is loaded from the COMMITTED question files, never hard-coded — a
// literal list here would drift the day a gold set gained a case (trap #6's
// cousin: the checker must not contain the answers). Any string value under a
// question-shaped key anywhere in those files counts, which is what catches
// BOTH eval arms — the prose controls are benchmark traffic too, and missing
// them was the first draft's mistake.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const QUESTION_KEYS = new Set(['q', 'query', 'question', 'proseControl']);

let CACHE = null;   // { key, set }

function collectStrings(node, out) {
  if (Array.isArray(node)) { for (const n of node) collectStrings(n, out); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && QUESTION_KEYS.has(k)) out.add(v.toLowerCase());
      else collectStrings(v, out);
    }
  }
}

function sourceFiles() {
  const files = [];
  try {
    for (const f of readdirSync(join(ROOT, 'test'))) {
      if (f.endsWith('.json')) files.push(join(ROOT, 'test', f));
    }
  } catch (_) { /* no test dir = no benchmark files */ }
  files.push(join(ROOT, 'scripts', 'probes.json'));
  return files.sort();
}

/** Every committed benchmark question string, lowercased. Cached by file mtimes. */
export function benchmarkStrings() {
  const files = sourceFiles();
  const key = files.map((f) => {
    try { return `${f}:${statSync(f).mtimeMs}`; } catch (_) { return `${f}:absent`; }
  }).join('|');
  if (CACHE && CACHE.key === key) return CACHE.set;
  const set = new Set();
  for (const f of files) {
    try { collectStrings(JSON.parse(readFileSync(f, 'utf8')), set); } catch (_) { /* not a question file */ }
  }
  CACHE = { key, set };
  return set;
}

export function isBenchmarkQuery(q) {
  try { return benchmarkStrings().has(String(q || '').toLowerCase()); }
  catch (_) { return false; }   // the stamp is telemetry; it must never fail a search
}
