// lib/rules-lane.js — STANDING RULES, RETURNED BESIDE THE RESULTS WHEN A TASK TOUCHES THEIR AREA (MEM-120).
//
// WHY. A rule ("parse-check every served file after an edit", "restart the app to load a server fix") is useful at
// exactly one moment — when the work touches its area — and ranking cannot guarantee it is in the top 8 of a search
// about something else. So a rule DECLARES its area and is returned OUTSIDE the ranking, never displacing a result:
//
//   metadata:
//     appliesTo: "public/, *.html, served file"
//
// One scalar, comma-separated (the frontmatter parser reads scalars). Each entry is either
//   • a PATH pattern — contains '/', '*' or a file extension: matched against the files the caller says it is touching
//     (`touching`) and the file names the query itself mentions. `public/` = anything under a public folder; `*.html`
//     = any html file; `lib/search.js` / `search.js` = that file; `**` crosses folders.
//   • a TOPIC — plain words: matched when the query contains them as words (case-insensitive), e.g. "served file".
// Only memories that declare `appliesTo` are in the lane, so the lane stays small and specific by construction. At
// most MAX_RULES come back, ordered by how many of their entries matched.

export const MAX_RULES = 5;
const EXT = /\.[a-z0-9]{1,5}$/i;

/** "a, b , c" -> ['a','b','c'] ; anything else -> null */
export function parseAppliesTo(v) {
  if (v == null) return null;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return list.length ? list.slice(0, 20) : null;
}

const isPathPattern = (p) => p.includes('/') || p.includes('*') || EXT.test(p);
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function pathMatcher(pattern) {
  const p = norm(pattern).replace(/^\.\//, '');
  if (p.endsWith('/')) {                                    // a folder: anything under it, wherever it sits
    const dir = p.replace(/^\/+|\/+$/g, '');
    return (f) => (`/${f}/`).includes(`/${dir}/`);
  }
  const rx = esc(p).replace(/\\\*\\\*\/?|\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?');
  const re = new RegExp(p.includes('/') ? `(?:^|/)${rx}$` : `(?:^|/)${rx}$`);
  return (f) => re.test(f);
}

function topicMatcher(topic) {
  const words = norm(topic).split(/\s+/).filter(Boolean).map(esc);
  if (!words.length) return () => false;
  const re = new RegExp(`(?:^|[^a-z0-9])${words.join('[\\s_-]+')}(?:$|[^a-z0-9])`, 'i');
  return (q) => re.test(q);
}

const FILE_IN_TEXT = /(?:^|[^\w.-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[a-z0-9]{1,5})(?![\w-])/gi;

/**
 * The rules whose declared area this request falls in.
 * @param docs      index docs (curated); a doc is a rule when it carries `appliesTo`
 * @param query     the search text
 * @param touching  paths the caller is working on (optional)
 * @returns [{ name, description, matched: [entries], why }]
 */
export function matchRules(docs, { query = '', touching = [] } = {}) {
  const files = [...(Array.isArray(touching) ? touching : [touching]).filter(Boolean).map(norm),
    ...[...String(query).matchAll(FILE_IN_TEXT)].map((m) => norm(m[1]))];
  const q = String(query || '');
  const seen = new Set();
  const out = [];
  for (const d of docs || []) {
    if (!d || !Array.isArray(d.appliesTo) || !d.appliesTo.length) continue;
    const key = d.file || d.name;
    if (seen.has(key)) continue;                            // section children share their file's frontmatter
    const matched = [];
    const why = [];
    for (const entry of d.appliesTo) {
      if (isPathPattern(entry)) {
        const m = pathMatcher(entry);
        const hit = files.find((f) => m(f));
        if (hit) { matched.push(entry); why.push(`${hit} matches ${entry}`); }
      } else if (topicMatcher(entry)(q)) { matched.push(entry); why.push(`the request mentions "${entry}"`); }
    }
    if (!matched.length) continue;
    seen.add(key);
    out.push({ name: d.parentName || d.name, description: d.description || '', matched, why: why.slice(0, 3).join('; ') });
  }
  out.sort((a, b) => b.matched.length - a.matched.length || a.name.localeCompare(b.name));
  return out.slice(0, MAX_RULES);
}
