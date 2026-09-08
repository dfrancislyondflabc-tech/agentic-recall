// lib/key-facts.js — Phase 4b: 1–3 atomic facts per section, indexed as keys.
//
// A section of a book is found today by the words it happens to contain. The
// experiment is whether a handful of facts written ABOUT it — "Mr Collins
// offers marriage; Elizabeth refuses him" — buys recall that the prose cannot,
// by giving BM25 a short, high-weight field to match against instead of six
// thousand words of period English.
//
// WHERE THE FACTS LIVE. A sidecar beside the document, `<file>.keyfacts.json`,
// keyed by section name:
//
//   { "pride-and-prejudice#chapter-xix": ["Mr Collins offers marriage…", …] }
//
// NOT frontmatter: the frontmatter parser is line-based by design (no arrays,
// no nesting), and a book is ONE file holding sixty-one sections, so there is
// no per-section frontmatter to write into. NOT the body either — a key fact
// is an indexing surface, and putting it in the body would change what a
// reader is handed and what every snippet quotes.
//
// The facts never become content: `bodyOf` is untouched, snippets are
// untouched, and the returned text of a hit is the same bytes either way.
//
// Flag: MEMORY_KEY_FACTS. Default is decided by the pre-registered bar in
// test/keyfacts-preregistration.md.

import { readFileSync, existsSync, statSync } from 'node:fs';

export function keyFactsEnabled() {
  return ['1', 'true', 'on'].includes(String(process.env.MEMORY_KEY_FACTS || '').toLowerCase());
}

export function keyFactsPathFor(docPath) {
  return String(docPath || '').replace(/\.md$/i, '') + '.keyfacts.json';
}

// One parse per sidecar per mtime — a book's sidecar is read once for all 61
// of its sections, not once per section.
const CACHE = new Map();   // path -> { key, map }
function sidecar(path) {
  if (!path || !existsSync(path)) return null;
  let key;
  try { const st = statSync(path); key = `${st.mtimeMs}:${st.size}`; } catch (_) { return null; }
  const hit = CACHE.get(path);
  if (hit && hit.key === key) return hit.map;
  let map = null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    map = new Map(Object.entries(raw).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(String).slice(0, 3)]));
  } catch (_) { map = null; }
  CACHE.set(path, { key, map });
  return map;
}

/**
 * Attach `keyFacts` to every doc that has any. Runs AFTER section splitting,
 * because the keys are per section. A no-op when the flag is off, so the
 * feature cannot cost an unflagged run a single stat call.
 */
export function attachKeyFacts(docs) {
  if (!keyFactsEnabled()) return docs;
  const byPath = new Map();
  for (const d of docs) {
    const src = d.path;
    if (!src) continue;
    if (!byPath.has(src)) byPath.set(src, sidecar(keyFactsPathFor(src)));
    const map = byPath.get(src);
    if (!map) continue;
    const facts = map.get(d.name);
    if (facts && facts.length) d.keyFacts = facts;
  }
  return docs;
}
