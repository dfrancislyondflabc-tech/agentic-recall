// lib/secrets.js — the four secret-exclusion mechanisms.
//
// The corpus contains plaintext credentials. Four independent mechanisms, each
// enforced BOTH at index time and at output time:
//
//   1. Filename denylist        — whole file never indexed; get() refuses.
//   2. Frontmatter opt-out      — metadata.secret: true, same treatment.
//   3. Section scrub            — a named section of a named file is removed
//                                 before chunking/BM25 and before get().
//   4. Pattern guard (backstop) — password-shaped text is redacted on the way
//                                 into the index file and on the way out of
//                                 every tool response, with a WARN log.
//
// Mechanism 4 exists precisely because 1-3 are curated lists and curated lists
// go stale. It is the thing that catches the credential nobody remembered.

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { secretsConfigPath } from './config.js';
import { warn, error } from './logger.js';

let CFG = null;

// ---- THE REDACTION-REASON VOCABULARY, CLOSED --------------------------------
// A bare [REDACTED] in a snippet tells the reader nothing — a blind reader hit
// one in a manual's default-credentials prose and could not tell whether the
// hole was a password, a key, or a scrub bug. Every emission now reads
// [REDACTED:<class>], where <class> is one of the names below and NOTHING else.
//
// 🟥 THE CLASS MUST NEVER DESCRIBE THE CONTENT. It names the PATTERN that
// fired, not the thing removed: no lengths, no fragments, no charset hints —
// any of those would hand back part of what the scrub took out.
//
// CLOSED means closed: a pattern declaring a class outside this set is a
// config error, and config errors here fail LOUDLY (the fail-closed path
// below), never by quietly emitting an unlisted reason.
export const REDACTION_CLASSES = Object.freeze(['credential-shaped', 'token-shaped', 'key-shaped', 'known-credential']);
const BARE_MARKER_RE = /\[REDACTED\]/;

/**
 * Validate a raw pattern list against the closed vocabulary. Throws on the
 * first violation — a missing class, an unlisted class, a replace string that
 * still carries the bare marker, or one whose marker names a different class
 * than the pattern declares. Exported so the suite can prove the gate fires.
 */
export function validatePatternClasses(patterns) {
  const known = new Set(REDACTION_CLASSES);
  for (const p of patterns || []) {
    if (!p.class) {
      throw new Error(`secrets pattern '${p.name}' declares no class — every pattern needs one of: ${REDACTION_CLASSES.join(', ')}`);
    }
    if (!known.has(p.class)) {
      throw new Error(`secrets pattern '${p.name}' declares class '${p.class}', which is not in the closed vocabulary (${REDACTION_CLASSES.join(', ')}) — add nothing here without a ruling; an unlisted reason must fail loudly, not ship quietly`);
    }
    const rep = p.replace ?? `[REDACTED:${p.class}]`;
    if (BARE_MARKER_RE.test(rep)) {
      throw new Error(`secrets pattern '${p.name}' would emit a bare [REDACTED] — markers must be [REDACTED:${p.class}]`);
    }
    if (!rep.includes(`[REDACTED:${p.class}]`)) {
      throw new Error(`secrets pattern '${p.name}' (class ${p.class}) has a replace that does not carry its own marker [REDACTED:${p.class}]`);
    }
  }
}

export function secretsConfig() {
  // 🟥 SAME MEMO CLASS AS D1, and the highest-stakes instance: this used to be
  // `if (CFG) return CFG`, so a pattern ADDED to secrets-exclude.json never
  // took effect in a running server. A scrub rule that does not load is a
  // scrub rule that does not exist. Keyed on the file's mtime+size now.
  //
  // FAIL-CLOSED SEMANTICS ARE UNCHANGED, deliberately: a re-read that does not
  // parse or does not validate lands in the same catch below and refuses
  // everything, exactly as a bad first read always has. Keeping the previous
  // good config would be the more available choice and the less safe one — the
  // whole point of failing closed is that an unreadable denylist means we
  // cannot promise the corpus is safe to index.
  let key;
  try { const st = statSync(secretsConfigPath()); key = `${st.mtimeMs}:${st.size}`; }
  catch (_) { key = 'absent'; }
  if (CFG && CFG._key === key) return CFG;
  try {
    const raw = JSON.parse(readFileSync(secretsConfigPath(), 'utf8'));
    validatePatternClasses(raw.patterns || []);
    CFG = {
      _key: key,
      excludeFiles: new Set((raw.excludeFiles || []).map((f) => f.toLowerCase())),
      sectionScrub: raw.sectionScrub || {},
      patterns: (raw.patterns || []).map((p) => ({
        name: p.name,
        class: p.class,
        re: new RegExp(p.re, p.flags || 'g'),
        replace: p.replace ?? `[REDACTED:${p.class}]`
      })),
      tokenHashes: new Set(raw.tokenHashesSha256 || [])
    };
  } catch (e) {
    // Fail CLOSED on config problems: without the denylist we cannot promise
    // the corpus is safe to index, so refuse everything rather than leak.
    error('secrets-exclude.json unreadable — failing closed:', e.message);
    CFG = {
      _key: key,
      excludeFiles: new Set(['*']),
      sectionScrub: {},
      patterns: [],
      tokenHashes: new Set(),
      failedClosed: true
    };
  }
  return CFG;
}

export function isFailedClosed() {
  return !!secretsConfig().failedClosed;
}

/** Mechanism 1: filename denylist. `file` may be a path or a bare filename. */
export function isDenylistedFile(file) {
  const cfg = secretsConfig();
  if (cfg.excludeFiles.has('*')) return true;
  return cfg.excludeFiles.has(basename(file).toLowerCase());
}

/** Mechanism 2: frontmatter opt-out. */
export function isSecretFrontmatter(front) {
  const v = front?.metadata?.secret;
  return v === true || v === 'true';
}

/** Combined index-time exclusion check. Returns a reason string, or null. */
export function exclusionReason(file, front) {
  if (isDenylistedFile(file)) return 'denylisted-filename';
  if (isSecretFrontmatter(front)) return 'frontmatter-secret';
  return null;
}

/**
 * Mechanism 3: section scrub. Removes each configured '## Heading' section
 * (heading line through the next same-or-higher-level heading, or EOF).
 */
export function scrubSections(file, text) {
  const cfg = secretsConfig();
  const headings = cfg.sectionScrub[basename(file)];
  if (!headings || !headings.length) return { text, removed: [] };

  const lines = text.split('\n');
  const removed = [];
  const drop = new Array(lines.length).fill(false);

  for (const heading of headings) {
    const wanted = heading.trim();
    const level = (wanted.match(/^#+/) || ['##'])[0].length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== wanted) continue;
      removed.push(wanted);
      drop[i] = true;
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/^(#{1,6})\s/);
        if (m && m[1].length <= level) break;
        drop[j] = true;
      }
    }
  }
  const kept = lines.filter((_, i) => !drop[i]);
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}

// ---- Mechanism 4: pattern guard ----

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Candidate secret-literals inside a token. A password rarely sits alone on a
 * line: it hides inside `'<word><punct><digits>'`, or inside a grep pattern in
 * a build checklist. So we test the whole token, the punctuation-stripped
 * token, and every long alphanumeric / alphabetic run within it.
 */
function candidates(token) {
  const out = new Set();
  const add = (s) => { if (s && s.length >= 6) out.add(s); };
  add(token);
  add(token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''));
  for (const m of token.matchAll(/[A-Za-z0-9*!#$%^&_+-]{6,}/g)) add(m[0]);
  for (const m of token.matchAll(/[A-Za-z]{6,}/g)) add(m[0]);
  for (const m of token.matchAll(/[A-Za-z0-9]{6,}/g)) add(m[0]);
  return [...out];
}

/**
 * Redact password-like text. Returns { text, hits: [names] }.
 * Safe to run repeatedly — the patterns skip text already carrying a marker,
 * old bare [REDACTED] and new [REDACTED:<class>] alike (their lookaheads match
 * \[REDACTED[\]:], because years of previously-scrubbed corpus text still hold
 * the bare form).
 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', hits: [] };
  const cfg = secretsConfig();
  const hits = [];
  let out = text;

  // (a) shape-based patterns
  for (const p of cfg.patterns) {
    p.re.lastIndex = 0;
    if (p.re.test(out)) {
      p.re.lastIndex = 0;
      out = out.replace(p.re, p.replace);
      hits.push(p.name);
    }
  }

  // (b) known-literal hashes (no plaintext secret stored in this repo)
  if (cfg.tokenHashes.size) {
    const found = new Set();
    for (const token of out.split(/\s+/)) {
      for (const cand of candidates(token)) {
        if (cfg.tokenHashes.has(sha256(cand.toLowerCase()))) found.add(cand);
      }
    }
    // Longest first: a match on the bare alphabetic run must not consume the
    // longer literal first and leave its numeric tail stranded in the output.
    for (const lit of [...found].sort((a, b) => b.length - a.length)) {
      out = out.split(lit).join('[REDACTED:known-credential]');
      hits.push('known-literal');
    }
  }

  return { text: out, hits: [...new Set(hits)] };
}

/** redact() + a WARN log naming where the leak nearly happened. */
export function guard(text, where) {
  const { text: clean, hits } = redact(text);
  if (hits.length) {
    warn(`pattern guard redacted [${hits.join(', ')}] in ${where} — a credential reached the ${where} stage; check secrets-exclude.json coverage`);
  }
  return clean;
}

/** Deep-guard an object about to become a tool response. */
export function guardValue(value, where) {
  if (typeof value === 'string') return guard(value, where);
  // A typed array is 384 numbers, never a credential, and it is NOT Array.isArray — so without
  // this it falls through to the Object.entries branch and comes back as a 384-key object
  // {"0":0.12,...} inside a tool response. Nothing throws; the shape is just quietly wrong.
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map((v) => guardValue(v, where));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = guardValue(v, where);
    return out;
  }
  return value;
}
