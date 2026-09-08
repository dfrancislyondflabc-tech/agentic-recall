// lib/git-join.js — turn a claim into a verified fact.
//
// THE PROBLEM THIS SOLVES. The corpus records what conversations SAID. Asking it
// "was this resolved?" means classifying language, and language has failed here
// three times: a correction vocabulary that fired on 76% of exchanges, an
// unresolved-statement vocabulary that fired on 24%, and a compaction-summary
// exclusion that sounded right and measured worse. Every one of those tried to
// infer, from words, something that has a hard record elsewhere.
//
// For engineering work that record is git. "I committed the fix" is not a sentence
// to be classified — it names a SHA, and a SHA either exists in the repository or
// it does not, either landed on the mainline or did not, on a date, touching files.
// Verification instead of inference: it cannot cry wolf, it cannot drift, and it
// needs no model.
//
// MEASURED COVERAGE (2026-08-23, 2,319 ingested exchanges): 404 (17%) name at least
// one hex token that is a REAL commit — 330 in a large sibling repo, 25 in this
// one. 707 hex-shaped candidates collapse to 355 real commits, so the shape alone
// means nothing and every token is checked.
//
// REPOS ARE CONFIGURED, NEVER INFERRED. An earlier draft planned to count commits
// "in this repo", meaning wherever the script happened to run — the memory server —
// while the corpus is about a large sibling codebase. That would have produced a
// confident number about the wrong project, exactly the silent-wrong-answer class
// this module exists to remove. Unconfigured, it returns nothing rather than guess.

import { execFileHidden, spawnHidden } from './child.js';   // MEM-83: no console window on Windows
import { delimiter } from 'node:path';
import { promisify } from 'node:util';
import { warn } from './logger.js';

const exec = promisify(execFileHidden);
const NUL = String.fromCharCode(0);

// A hex run of 7-10 chars. Deliberately loose: precision comes from git, not from
// the regex. Pure digits are dropped (years, counts and ports are not SHAs).
const SHA_RE = /\b[0-9a-f]{7,10}\b/g;

export function extractShas(text) {
  const body = String(text || '');
  // Strip frontmatter: every ingested exchange carries a hex sessionId there, which
  // would otherwise make 100% of documents look like they cite a commit.
  const parts = body.split('---');
  const scan = parts.length > 2 ? parts.slice(2).join('---') : body;
  return [...new Set((scan.match(SHA_RE) || []).filter((t) => !/^\d+$/.test(t)))];
}

export function configuredRepos() {
  const raw = process.env.MEMORY_GIT_REPOS;
  if (!raw) return [];
  // PLATFORM DELIMITER, NOT ':'. A Windows path is "C:\\repos\\thing", so splitting
  // a list on ':' turns one repo into two broken ones. node's `delimiter` is ';' on
  // Windows and ':' elsewhere. Written with ':' first, which would have silently
  // disabled every git check on Windows -- configuredRepos() would return garbage
  // paths, every lookup would miss, and verification would just quietly do nothing.
  return raw.split(delimiter).map((s) => s.trim()).filter(Boolean)
    .map((dir) => ({ dir, label: dir.split(/[\\/]/).filter(Boolean).pop() || dir }));
}

// sha -> record | null (null = checked and genuinely absent). Persisting the
// negatives matters: most candidates are false positives, and re-checking them on
// every query would dominate the cost.
const CACHE = new Map();
const cacheKey = (repo, sha) => repo + ' ' + sha;

/**
 * Verify many candidate SHAs against one repo IN ONE PROCESS.
 *
 * `git cat-file --batch-check` reads requests from stdin, so 700 candidates cost
 * one spawn instead of 700 (the per-process version took ~40 s over the corpus).
 *
 * SPAWN, NOT execFile. promisify(execFile) has no `input` option -- that belongs to
 * execFileSync -- so passing one is silently ignored, stdin never closes, and
 * cat-file waits forever. Written that way first, and it hung the process: inside
 * the MCP server that would have been a query that never returns.
 */
function batchCheck(repo, shas) {
  if (!shas.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const out = new Map();
    let stdout = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(out); } };
    let child;
    try {
      child = spawnHidden('git', ['-C', repo.dir, 'cat-file', '--batch-check'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      warn('git-join: cannot spawn git in ' + repo.label + ': ' + e.message);
      return finish();
    }
    // A hung git must never hang a query. The batch is one process over local
    // objects; seconds is already pathological.
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(); }, 15000);
    child.on('error', (e) => { clearTimeout(timer); warn('git-join: ' + repo.label + ': ' + e.message); finish(); });
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => {
      clearTimeout(timer);
      stdout.split('\n').forEach((line, i) => {
        if (!line.trim()) return;
        const parts = line.split(/\s+/);
        // "<oid> commit <size>" on success; "<token> missing" otherwise.
        if (parts[1] === 'commit' && shas[i]) out.set(shas[i], parts[0]);
      });
      finish();
    });
    child.stdin.on('error', () => { /* closed early; the close handler resolves */ });
    child.stdin.end(shas.map((s) => s + '^{commit}').join('\n') + '\n');
  });
}

/**
 * Metadata + mainline membership for SHAs already known to exist.
 *
 * SPAWN COUNT IS THE WHOLE COST. Measured on this machine every git invocation is
 * ~150-180 ms of process startup, whether the repo is 5 MB or 481 MB — so the
 * first version, which ran `show -s`, `merge-base` and `show --name-only`
 * separately for every commit, spent 2.6 s on a three-commit response. One
 * `git log --no-walk` returns metadata AND file lists for every commit at once,
 * and the ancestry checks run concurrently instead of in series.
 */
async function describe(repo, resolved) {
  const out = new Map();
  const shas = [...resolved.keys()];
  if (!shas.length) return out;
  const oids = shas.map((s) => resolved.get(s));
  // GIT EXPANDS %x00/%x01; a literal control byte in argv does NOT survive the
  // round trip. Written the literal way first and every field came back joined,
  // so nothing parsed and verification silently returned empty.
  const SEP = String.fromCharCode(1) + 'COMMIT' + String.fromCharCode(1);
  const F = '%x01COMMIT%x01%H%x00%ad%x00%an%x00%s';

  let text = '';
  try {
    const { stdout } = await exec('git', ['-C', repo.dir, 'log', '--no-walk',
      '--format=' + F, '--name-only', '--date=short', ...oids],
      { maxBuffer: 16 * 1024 * 1024 });
    text = stdout;
  } catch (e) {
    warn('git-join: log failed in ' + repo.label + ': ' + e.message);
    return out;
  }

  const byFull = new Map();
  for (const block of text.split(SEP)) {
    if (!block.trim()) continue;
    const [head, ...rest] = block.split('\n');
    const [full, date, author, subject] = head.split(NUL);
    if (!full) continue;
    const files = rest.filter((l) => l.trim()).length;
    byFull.set(full, { fullSha: full, date, author, subject, files });
  }

  // Ancestry: one process each, but CONCURRENT. "It exists" and "it shipped" are
  // different claims — a commit can sit in the object store after being amended
  // away, or live only on an abandoned branch — so both are reported.
  const anc = await Promise.all(oids.map((oid) =>
    exec('git', ['-C', repo.dir, 'merge-base', '--is-ancestor', oid, 'HEAD'])
      .then(() => true).catch(() => false)));

  shas.forEach((short, i) => {
    const meta = byFull.get(oids[i]);
    if (!meta) return;
    out.set(short, { sha: short, repo: repo.label, onMainline: anc[i], ...meta });
  });
  return out;
}

// IDENTIFIERS, NOT JUST COMMITS.
//
// Five pre-registered FALSE premises were run against the corpus. Two were caught
// by term co-occurrence; three were not, and could not be — "the dream resolution
// arm shipped", "latest uses a small local model", "summaries are excluded by
// default" all have their terms co-occurring, because the corpus DISCUSSED each
// one before rejecting it. No amount of term matching separates "X happened" from
// "we considered X and decided against it": both look identical in the words.
//
// The working tree does separate them. If a flag was implemented, its name is in
// the code; if it was only ever discussed, it is not. `git grep` over the
// configured repos answers all three instantly, and cannot be argued with.
//
// Only unambiguous shapes are extracted -- CONSTANT_CASE names, --flags, and
// path-like tokens. Ordinary words are deliberately excluded: grepping for
// "summaries" would match prose everywhere and prove nothing.
const IDENT_RES = [
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g,             // MEMORY_CURRENCY_REPOS
  /--[a-z][a-z0-9-]{2,}\b/g,                         // --shadow-all
  /\b[\w.-]+\/[\w.\/-]+\.[a-z]{2,4}\b/g             // lib/git-join.js
];

export function extractIdentifiers(text) {
  const out = new Set();
  for (const re of IDENT_RES) for (const m of String(text || '').match(re) || []) out.add(m);
  return [...out];
}

// CACHED AND TIME-BOXED, because C2 calls this on ordinary queries.
//
// `verify` was called by hand a few times per session, so an uncached grep that
// could run for as long as it liked was fine. Auto-verification puts this on the
// query path, where a `git grep` across a large working tree is latency the user
// pays on every search. Two guards:
//
//   - a process-lifetime cache keyed by identifier AND repo set. HEAD moving does
//     not invalidate it, which is the right trade: the answer to "does this name
//     exist anywhere in the code" is stable across a session, and being one commit
//     stale on that is worth far more than re-grepping the tree every query.
//   - a timeout. A grep that overruns is treated as UNKNOWN, never as absent --
//     reporting "not in the code" because git was slow would manufacture exactly
//     the false premise this check exists to catch.
const IDENT_CACHE = new Map();
// READ PER CALL, not at module load. A module-load constant cannot be tuned by a
// caller that sets the variable after import, and cannot be tested at all -- the
// first version of this passed its timeout test only because the value happened
// to be in the environment before node started.
const identTimeoutMs = () => Number(process.env.MEMORY_IDENT_TIMEOUT_MS || 1500);

/** Does this identifier appear in the CODE of any configured repo? */
export async function findIdentifiers(idents) {
  const repos = configuredRepos();
  const out = new Map();
  if (!repos.length || !idents.length) return out;
  const repoKey = repos.map((r) => r.dir).join('|');

  const todo = [];
  for (const id of idents) {
    const hit = IDENT_CACHE.get(repoKey + '\u0000' + id);
    if (hit) out.set(id, hit); else todo.push(id);
  }
  if (!todo.length) return out;

  await Promise.all(repos.map(async (repo) => {
    await Promise.all(todo.map(async (id) => {
      if (out.get(id)?.found) return;
      try {
        // -F fixed-string so a flag or path is never read as a pattern; --quiet
        // makes this an existence check rather than a content dump.
        await exec('git', ['-C', repo.dir, 'grep', '--quiet', '-F', '-I', id, 'HEAD'],
          { maxBuffer: 1024 * 1024, timeout: identTimeoutMs() });
        out.set(id, { found: true, repo: repo.label });
      } catch (e) {
        // ETIMEDOUT / SIGTERM -> we do not know. Anything else -> git grep's
        // exit code 1, which is a real "no match in this repo".
        if (e && (e.killed || e.code === 'ETIMEDOUT' || e.signal)) {
          if (!out.get(id)?.found) out.set(id, { found: false, unknown: true });
        } else if (!out.has(id)) out.set(id, { found: false });
      }
    }));
  }));

  for (const id of todo) {
    const v = out.get(id);
    if (v && !v.unknown) IDENT_CACHE.set(repoKey + '\u0000' + id, v);
  }
  return out;
}

/**
 * C2 -- AUTO-VERIFY THE IDENTIFIERS IN A QUERY.
 *
 * `verify` closed 3 of 3 false premises that term co-occurrence provably cannot
 * catch. Its problem was never accuracy, it was that it only fired when the
 * caller already suspected something -- which is never the moment it is needed.
 *
 * Returns null unless it has something WORTH SAYING. Deliberately narrow:
 *   - nothing without MEMORY_GIT_REPOS, and nothing if MEMORY_AUTO_VERIFY=0
 *   - at most MAX_AUTO_IDENTS per query, so one query is one bounded burst
 *   - reports ONLY the absent ones. "Every name you used exists" is noise on a
 *     search result; "this name is in no repo" is the whole point.
 *
 * It says NOT IN THE CODE OF ANY CONFIGURED REPO -- not "this is false". An
 * identifier can be absent because it lives in a repo nobody configured, or was
 * renamed. Overstating that would trade one kind of wrong answer for another.
 */
const MAX_AUTO_IDENTS = 4;

export async function autoVerifyQuery(query) {
  if (process.env.MEMORY_AUTO_VERIFY === '0' || process.env.MEMORY_AUTO_VERIFY === 'false') return null;
  if (!configuredRepos().length) return null;
  const idents = extractIdentifiers(query).slice(0, MAX_AUTO_IDENTS);
  if (!idents.length) return null;
  let map;
  try { map = await findIdentifiers(idents); } catch { return null; }
  const notInCode = [...map.entries()].filter(([, v]) => !v.found && !v.unknown).map(([k]) => k);
  if (!notInCode.length) return null;
  return {
    identifiersNotInCode: notInCode,
    note: `${notInCode.map((i) => JSON.stringify(i)).join(', ')} — named in your query, present in NO `
      + `configured repo. An identifier that was implemented is in the code; one that was only ever `
      + `discussed is not. The corpus contains the discussion either way, so a confident-looking `
      + `answer here may be describing something that was considered and dropped. Check before relying on it.`
  };
}

/** Verify candidates across every configured repo. Unverifiable ones are absent. */
export async function verifyShas(candidates) {
  const repos = configuredRepos();
  if (!repos.length || !candidates.length) return new Map();
  const found = new Map();
  // Repos are independent, so check them CONCURRENTLY rather than one after the
  // other -- with two configured that halves the cold cost of a query.
  await Promise.all(repos.map(async (repo) => {
    const unknown = candidates.filter((s) => !CACHE.has(cacheKey(repo.dir, s)));
    if (!unknown.length) return;
    const resolved = await batchCheck(repo, unknown);
    const described = await describe(repo, resolved);
    for (const s of unknown) CACHE.set(cacheKey(repo.dir, s), described.get(s) || null);
  }));
  for (const repo of repos) {
    for (const s of candidates) {
      const rec = CACHE.get(cacheKey(repo.dir, s));
      // First repo to claim a SHA wins; the record names which repo answered.
      if (rec && !found.has(s)) found.set(s, rec);
    }
  }
  return found;
}

/**
 * Given a document's text, what does the record actually show?
 * Returns null when nothing is configured or nothing is citable, so callers omit
 * the field rather than emitting an empty and meaningless one.
 */
export async function verifyClaims(text) {
  if (!configuredRepos().length) return null;
  const cands = extractShas(text);
  const idents = extractIdentifiers(text);
  const identMap = await findIdentifiers(idents);
  const inCode = [...identMap.entries()].filter(([, v]) => v.found).map(([k, v]) => ({ identifier: k, repo: v.repo }));
  const notInCode = [...identMap.entries()].filter(([, v]) => !v.found).map(([k]) => k);
  const identReport = idents.length ? {
    identifiersInCode: inCode,
    identifiersNotInCode: notInCode,
    identifierNote: notInCode.length
      ? `NOT FOUND IN ANY CONFIGURED REPO: ${notInCode.map((i) => JSON.stringify(i)).join(', ')}. ` +
        'An identifier that was implemented is IN THE CODE; one that was only ever discussed is ' +
        'not. This is the check that separates "X shipped" from "we considered X and decided ' +
        'against it" — which no amount of term matching can do, because the corpus contains the ' +
        'discussion either way.'
      : 'Every identifier named here exists in the code of a configured repo.'
  } : null;

  if (!cands.length) {
    return identReport ? { citedShaCandidates: 0, verifiedCommits: [], ...identReport } : null;
  }
  const found = await verifyShas(cands);
  if (!found.size) {
    return {
      ...(identReport || {}),
      citedShaCandidates: cands.length, verifiedCommits: [], unverified: cands.slice(0, 8),
      note: 'This text contains hex-shaped tokens but NONE resolve to a commit in the configured ' +
        'repos. Hex shape alone means nothing (measured: 707 candidates -> 355 real commits), and ' +
        'the commit may live in a repo that is not configured.'
    };
  }
  const list = [...found.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const landed = list.filter((c) => c.onMainline).length;
  return {
    ...(identReport || {}),
    citedShaCandidates: cands.length,
    verifiedCommits: list,
    note: 'VERIFIED AGAINST GIT, NOT INFERRED FROM WORDS. ' + list.length + ' commit(s) named here ' +
      'are real; ' + landed + ' are on the mainline of their repo. A claim that work was committed ' +
      'is settled by this, not by the sentence around it. Absence proves nothing — the commit may ' +
      'be in a repo that is not configured (MEMORY_GIT_REPOS).'
  };
}

// THE REVERSE JOIN: git -> corpus, instead of corpus -> git.
//
// Everything above reads a SHA out of an exchange and checks it. That only works
// when the conversation happened to write the SHA down, and measured on a known
// day it usually does not: of 12 commits made during one session, the text of that
// session named exactly 2. The work was done through tool calls; ingest captures
// conversation prose. So the corpus systematically under-records its own outcomes,
// and no amount of reading it more cleverly can recover what was never written.
//
// Time can. A conversation has timestamps and so do commits, so the join needs no
// SHA, no vocabulary and no judgment: what landed in these repos while this was
// being discussed? That converts "I will commit the fix" -- a promise, and the
// hardest thing in the corpus to resolve -- into the record of whether anything
// actually landed in the minutes that followed.
//
// It is EVIDENCE, NOT PROOF, and is labelled that way: a commit inside the window
// may be unrelated work, and related work may land days later. It narrows the
// question from "did this ever happen" to "here is what happened at that moment".
const RANGE_CACHE = new Map();

export async function commitsInRange(sinceIso, untilIso, { max = 25 } = {}) {
  const repos = configuredRepos();
  if (!repos.length || !sinceIso || !untilIso) return [];
  const since = new Date(sinceIso), until = new Date(untilIso);
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime())) return [];
  if (until <= since) return [];
  const key = sinceIso + '|' + untilIso + '|' + max;
  if (RANGE_CACHE.has(key)) return RANGE_CACHE.get(key);

  const out = [];
  await Promise.all(repos.map(async (repo) => {
    try {
      const fmt = '%h' + '%x00' + '%aI' + '%x00' + '%s';
      const { stdout } = await exec('git', ['-C', repo.dir, 'log',
        '--since=' + since.toISOString(), '--until=' + until.toISOString(),
        '--format=' + fmt, '--max-count=' + max, 'HEAD'], { maxBuffer: 4 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [sha, when, subject] = line.split(NUL);
        if (sha) out.push({ sha, repo: repo.label, at: when, subject });
      }
    } catch (e) {
      warn('git-join: range log failed in ' + repo.label + ': ' + e.message);
    }
  }));
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  RANGE_CACHE.set(key, out);
  return out;
}

/**
 * CORPUS CURRENCY — how far behind the world the corpus is, as one number.
 *
 * The corpus cannot know about anything after its newest exchange. That is stated
 * in the guidance already, but a sentence is easy to skip and a count is not:
 * "the newest thing said was 3 days ago; 47 commits have landed since" tells you
 * immediately whether the last word is still worth anything.
 *
 * The repos come from MEMORY_GIT_REPOS and are NEVER inferred. An earlier draft of
 * this idea planned to count commits "in this repo", meaning wherever the code
 * happened to run -- the memory server -- while the corpus is about a sibling codebase.
 * That would have produced a confident number about the wrong project.
 */
export async function corpusCurrency(newestExchangeIso) {
  const repos = configuredRepos();
  if (!repos.length || !newestExchangeIso) return null;
  const since = new Date(newestExchangeIso);
  if (!Number.isFinite(since.getTime())) return null;

  const per = [];
  await Promise.all(repos.map(async (repo) => {
    try {
      const { stdout } = await exec('git', ['-C', repo.dir, 'rev-list', '--count',
        '--since=' + since.toISOString(), 'HEAD'], { maxBuffer: 1024 * 64 });
      const n = Number(String(stdout).trim());
      if (Number.isFinite(n)) per.push({ repo: repo.label, commitsSince: n });
    } catch (e) {
      warn('git-join: currency count failed in ' + repo.label + ': ' + e.message);
    }
  }));
  if (!per.length) return null;
  const total = per.reduce((n, r) => n + r.commitsSince, 0);
  const ageHours = Math.max(0, (Date.now() - since.getTime()) / 3600000);
  return {
    newestExchange: newestExchangeIso,
    corpusAgeHours: Number(ageHours.toFixed(1)),
    commitsSince: per,
    note: total === 0
      ? 'The corpus is current with the configured repos: nothing has landed since its newest ' +
        'exchange. (It can still be behind work that leaves no commit.)'
      : 'CORPUS IS BEHIND THE WORLD: ' + total + ' commit(s) have landed in ' +
        per.filter((r) => r.commitsSince).map((r) => r.repo).join(', ') + ' since the newest ' +
        'exchange was written. Nothing here can know about any of them. This is the gap between ' +
        'what was SAID and what HAPPENED, and no query closes it — check git for anything recent.'
  };
}

