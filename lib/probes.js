// lib/probes.js — machine-checkable current truth (Phase 3a, DARK).
//
// A memory can now carry a PROBE: a recorded command from the CLOSED
// vocabulary below plus a recorded expected value, compared by equality — the
// gap analysis measured 19% of sampled claims silently false and 86% of those
// checkable by a script, and every language-based staleness attempt here has
// failed (three times internally; externally the best model manages 55.2%).
// So: arithmetic and equality, never language, never inference.
//
// EXECUTION DISCIPLINE (every rule tested by injection):
//   * The vocabulary is CLOSED — an unknown predicate is refused (UNKNOWN),
//     never "tried".
//   * `execFile` ONLY, never a shell. Argument validation rejects shell
//     metacharacters on paths, refs, and command argv as defence in depth.
//   * `cmd_output_matches` runs only allowlisted binaries — git (read-only
//     subcommand allowlist), node (scripts/*.js inside the three named
//     repos), ls, wc.
//   * sqlite opens READ-ONLY, enforced in code (the mode=ro rule); only a
//     SELECT is accepted at all.
//   * 5s timeout per probe.
//   * VERDICTS: FRESH | STALE | UNKNOWN | UNPROVABLE. Any error, timeout,
//     refusal, or switched-off level is UNKNOWN — NEVER STALE (the C2 rule: a
//     probe that cries wolf because git was slow teaches everyone to ignore
//     it). UNPROVABLE means the claim's ANCHOR is gone (file/db/repo absent):
//     the probe cannot even ask its question any more.
//   * Results go to the SIDECAR (.probe-results.json). The sweep never writes
//     a memory file, and nothing in ranking reads any of this — advisory
//     surfacing is gated on Phase 3b's calibration.
//
// SYNTAX (final — the calibration file is written against this):
//   metadata:
//     probe: <predicate> <arg1>[ :: <arg2>]
//     probe_expected: <value>
//   Args are separated by the literal ' :: ' so paths may contain spaces.
//   Expected-value comparators: 'true'/'false' · exact string · numeric
//   '>=N' '<=N' '>N' '<N' · '~substr' (containment).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileHidden } from './child.js';   // MEM-83: no console window on Windows
import { createHash } from 'node:crypto';
import { basename, dirname, resolve as resolvePath, join, delimiter } from 'node:path';
import { probeResultsPath, probeLevel } from './config.js';
import { warn } from './logger.js';

const TIMEOUT_MS = Number(process.env.MEMORY_PROBE_TIMEOUT_MS || 5000);

// Shell metacharacters have no business in a path, a ref, or an argv word.
// grep literals and SELECT text are exempt BY DESIGN (they are data, execFile
// passes them as single argv entries, and 'v112 (CURRENT)' is a legitimate
// thing to count) — their predicates carry their own guards instead.
const META_RE = /[;&|`$<>(){}\\\n\r"']/;
const cleanArg = (s, what) => {
  if (META_RE.test(String(s))) throw new Refusal(`${what} contains shell metacharacters — refused`);
  return String(s);
};

class Refusal extends Error {}        // -> UNKNOWN, loudly
class Unprovable extends Error {}     // -> the anchor is gone

const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

const execP = (bin, args, opts = {}) => new Promise((res, rej) => {
  execFileHidden(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, ...opts },
    (err, stdout, stderr) => err ? rej(Object.assign(err, { stdout, stderr })) : res({ stdout, stderr }));
});

const gitRepoOf = (p) => {
  const dir = cleanArg(p, 'repo path');
  if (!existsSync(dir)) throw new Unprovable(`repo ${dir} does not exist`);
  return dir;
};

const GIT_REF_RE = /^[A-Za-z0-9._^~/-]+(\.\.\.?[A-Za-z0-9._^~/-]+)?$/;
// The peel operator, and ONLY the peel operator, may carry braces. Found by
// the 3b calibration: two cases pinning ship-tag shas were refused because
// braces are excluded outright, and `<tag>^{}` is the only way to resolve an
// ANNOTATED tag (which `git tag -a` — the ship-tag protocol — always makes)
// to the commit it points at. Without it a sha-pinning probe on any real
// release tag reads the TAG OBJECT's sha and can never match. The suffix is
// allowlisted by exact shape rather than by adding braces to the character
// class, so `HEAD{anything}` stays refused.
const GIT_PEEL_RE = /\^\{(commit|tag|tree|blob|object)?\}$/;
const gitRef = (r) => {
  const ref = String(r).trim();
  const peel = GIT_PEEL_RE.exec(ref);
  const base = peel ? ref.slice(0, peel.index) : ref;
  if (!(GIT_REF_RE.test(base) || /^--since=[0-9T:.Z+-]+$/.test(base))) {
    throw new Refusal(`'${ref}' is not an allowed git ref/range/--since shape`);
  }
  return ref;
};

// cmd_output_matches allowlist — the WHOLE surface, nothing else executes.
const GIT_SUBCOMMANDS = new Set(['tag', 'log', 'rev-parse', 'rev-list', 'status', 'show', 'describe', 'branch', 'remote']);
// EMPTY BY DEFAULT — this is an execution allowlist, so the safe default is that no
// node script is runnable by a probe at all. Opt in with MEMORY_PROBE_SCRIPT_ROOTS
// (`:`-separated, or `;` on Windows), naming only directories whose scripts you are
// willing to let a probe execute. Anything outside these roots is refused, and an
// empty list refuses everything, which is what a fresh install should do.
// Read per call, not once at import: an execution allowlist that cannot be changed
// without restarting the process is also an allowlist that cannot be tested.
const nodeScriptRoots = () => (process.env.MEMORY_PROBE_SCRIPT_ROOTS || '')
  .split(delimiter).filter(Boolean).map((d) => resolvePath(d));
function allowlistedArgv(words) {
  const argv = words.map((w) => cleanArg(w, 'command argument'));
  const bin = basename(argv[0] || '');
  if (bin === 'git') {
    // The subcommand is the first non-option word that is not an option's
    // VALUE: `git -C <dir> tag` — <dir> is -C's argument, not the subcommand.
    // The first draft took the -C value as the subcommand and refused every
    // repo-scoped invocation; the injection test caught it.
    let sub = null;
    for (let i = 1; i < argv.length; i++) {
      const w = argv[i];
      if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree') { i++; continue; }
      if (w.startsWith('-')) continue;
      sub = w; break;
    }
    if (!GIT_SUBCOMMANDS.has(sub)) throw new Refusal(`git subcommand '${sub}' is not on the read-only allowlist`);
    return ['git', argv.slice(1)];
  }
  if (bin === 'node') {
    const script = resolvePath(String(argv[1] || ''));
    const roots = nodeScriptRoots();
    if (!script.endsWith('.js') || !roots.some((r) => script.startsWith(r + '/'))) {
      throw new Refusal(roots.length
        ? `node may only run scripts/*.js inside a root named by MEMORY_PROBE_SCRIPT_ROOTS — '${argv[1]}' is not`
        : `node script execution is disabled: MEMORY_PROBE_SCRIPT_ROOTS names no allowed root, so '${argv[1]}' is refused`);
    }
    return [process.execPath, argv.slice(1)];
  }
  if (bin === 'ls') return ['/bin/ls', argv.slice(1)];
  if (bin === 'wc') return ['/usr/bin/wc', argv.slice(1)];
  throw new Refusal(`binary '${argv[0]}' is not on the allowlist (git, node scripts/*, ls, wc)`);
}

// ---- the predicates (CLOSED — anything else is refused) ---------------------
const PREDICATES = {
  cheap: {
    async file_exists([path]) {
      // 🟥 F3 (2026-08-30). "The file is not there" and "I cannot see the disk it
      // lives on" are different claims, and only the first is evidence about the
      // MEMORY. Until now an unmounted volume read STALE here while grep_count and
      // file_hash_span both returned UNPROVABLE on the same path — so unplugging a
      // drive silently reclassified true memories as stale. If the parent directory
      // cannot be read, refuse to judge.
      {
        const target = cleanArg(path, 'path');
        const parent = dirname(target);
        if (!existsSync(parent)) throw new Unprovable(
          `the directory ${parent} is not reachable (unmounted volume, or a path that never existed), ` +
          'so whether the file exists cannot be determined — this says nothing about the memory');
      }
      return existsSync(cleanArg(path, 'path')) ? 'true' : 'false';
    },
    async file_hash_span([path, span]) {
      const p = cleanArg(path, 'path');
      if (!existsSync(p)) throw new Unprovable(`file ${p} does not exist`);
      const m = /^(\d+)-(\d+)$/.exec(String(span || '').trim());
      if (!m) throw new Refusal(`span '${span}' must be <startLine>-<endLine>`);
      const [a, b] = [Number(m[1]), Number(m[2])];
      const lines = readFileSync(p, 'utf8').split('\n');
      if (a < 1 || b < a || a > lines.length) throw new Unprovable(`span ${a}-${b} is outside the file (${lines.length} lines) — the anchored content moved or shrank`);
      return sha12(lines.slice(a - 1, b).join('\n'));
    },
    async grep_count([path, literal]) {
      const p = cleanArg(path, 'path');
      if (!existsSync(p)) throw new Unprovable(`path ${p} does not exist`);
      if (literal == null || literal === '') throw new Refusal('grep_count needs a literal to count');
      // -F: LITERAL, never a regex — 'v112 (CURRENT)' must mean those bytes.
      const args = ['-F', '-c', '-r', '--', String(literal), p];
      try {
        const { stdout } = await execP('grep', args);
        return String(stdout.split('\n').filter(Boolean)
          .reduce((n, l) => n + (Number(l.split(':').pop()) || 0), 0));
      } catch (e) {
        if (e.code === 1) return '0';               // grep exit 1 = no matches
        throw e;
      }
    },
    async git_tag_exists([repo, tag]) {
      const dir = gitRepoOf(repo);
      const t = cleanArg(String(tag || '').trim(), 'tag');
      try { await execP('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/tags/${t}`]); return 'true'; }
      catch (e) { if (e.code === 1) return 'false'; throw e; }
    },
    async git_rev_count([repo, range]) {
      const dir = gitRepoOf(repo);
      const ref = gitRef(range);
      const args = ref.startsWith('--since=')
        ? ['-C', dir, 'rev-list', '--count', ref, 'HEAD']
        : ['-C', dir, 'rev-list', '--count', ref];
      const { stdout } = await execP('git', args);
      return String(stdout).trim();
    },
    async git_rev_parse([repo, ref]) {
      const dir = gitRepoOf(repo);
      const { stdout } = await execP('git', ['-C', dir, 'rev-parse', gitRef(ref)]);
      return String(stdout).trim();
    },
    async date_past([iso]) {
      const t = Date.parse(String(iso || '').trim());
      if (!Number.isFinite(t)) throw new Refusal(`'${iso}' is not a parseable date`);
      return Date.now() > t ? 'true' : 'false';
    }
  },
  all: {
    async port_listening([port]) {
      const n = Number(String(port).trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Refusal(`'${port}' is not a port`);
      const net = await import('node:net');
      return new Promise((res) => {
        const sock = net.connect({ port: n, host: '127.0.0.1' });
        const done = (v) => { try { sock.destroy(); } catch (_) {} res(v); };
        sock.once('connect', () => done('true'));
        sock.once('error', () => done('false'));
        sock.setTimeout(TIMEOUT_MS, () => done('false'));
      });
    },
    async http_status([url]) {
      const u = new URL(cleanArg(url, 'url'));
      if (!['http:', 'https:'].includes(u.protocol)) throw new Refusal(`'${u.protocol}' is not http/https`);
      const mod = await import(u.protocol === 'https:' ? 'node:https' : 'node:http');
      return new Promise((res, rej) => {
        const req = mod.request(u, { method: 'GET', timeout: TIMEOUT_MS }, (r) => { r.resume(); res(String(r.statusCode)); });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', rej);
        req.end();
      });
    },
    async sqlite_query_ro([db, query]) {
      const p = cleanArg(db, 'db path');
      if (!existsSync(p)) throw new Unprovable(`database ${p} does not exist`);
      const q = String(query || '').trim();
      // The mode=ro rule, enforced in code twice over: only a SELECT is
      // accepted at all, and the handle is opened readOnly so even a SELECT
      // that turns out to be something else cannot write.
      if (!/^select\b/i.test(q)) throw new Refusal('sqlite_query_ro accepts a SELECT and nothing else');
      const { DatabaseSync } = await import('node:sqlite');
      const dbh = new DatabaseSync(p, { readOnly: true });
      try {
        const row = dbh.prepare(q).get();
        return row == null ? '' : Object.values(row).map(String).join('|');
      } finally { try { dbh.close(); } catch (_) {} }
    },
    async cmd_output_matches(args) {
      const words = String(args[0] || '').split(/\s+/).filter(Boolean);
      if (!words.length) throw new Refusal('cmd_output_matches needs a command');
      const [bin, argv] = allowlistedArgv(words);
      const { stdout } = await execP(bin, argv);
      return String(stdout).trim().slice(0, 4096);
    }
  }
};

export const PROBE_PREDICATES = Object.freeze([
  ...Object.keys(PREDICATES.cheap), ...Object.keys(PREDICATES.all)
]);

/** `probe:` line -> { predicate, args[] } (args split on the literal ' :: '). */
export function parseProbe(line) {
  const s = String(line || '').trim();
  const sp = s.indexOf(' ');
  const predicate = sp === -1 ? s : s.slice(0, sp);
  const rest = sp === -1 ? '' : s.slice(sp + 1);
  const args = rest ? rest.split(' :: ').map((a) => a.trim()) : [];
  return { predicate, args };
}

/** The comparator vocabulary (documented in the syntax reference). */
export function matchesExpected(actual, expected) {
  const e = String(expected ?? '').trim();
  const a = String(actual ?? '').trim();
  if (e.startsWith('~')) return a.toLowerCase().includes(e.slice(1).trim().toLowerCase());
  const cmp = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(e);
  if (cmp) {
    const n = Number(a);
    if (!Number.isFinite(n)) return false;
    const rhs = Number(cmp[2]);
    return cmp[1] === '>=' ? n >= rhs : cmp[1] === '<=' ? n <= rhs : cmp[1] === '>' ? n > rhs : n < rhs;
  }
  return a === e;
}

/**
 * Run ONE probe to a verdict. Never throws; never writes anything.
 * { verdict, actual, reason, ranMs } — UNKNOWN on any failure, UNPROVABLE
 * when the anchor is gone, and validUntil expiry is STALE by author-declared
 * arithmetic (a date comparison, not an inference).
 */
export async function runProbe(doc, { level = probeLevel() } = {}) {
  const out = { name: doc.name, file: doc.file, probe: doc.probe || null,
    expected: doc.probeExpected ?? null, asOf: doc.asOf || null,
    validUntil: doc.validUntil || null, at: new Date().toISOString() };

  if (doc.validUntil) {
    const t = Date.parse(doc.validUntil);
    if (Number.isFinite(t) && Date.now() > t) {
      return { ...out, verdict: 'STALE', actual: null,
        reason: `validUntil ${doc.validUntil} has passed — author-declared expiry (arithmetic, no probe needed)` };
    }
  }
  if (!doc.probe) return { ...out, verdict: 'UNKNOWN', actual: null, reason: 'no probe configured (validUntil-only entry, not yet expired)' };

  if (level === 'off') return { ...out, verdict: 'UNKNOWN', actual: null, reason: 'probe level is off' };

  const { predicate, args } = parseProbe(doc.probe);
  const tier = PREDICATES.cheap[predicate] ? 'cheap' : (PREDICATES.all[predicate] ? 'all' : null);
  if (!tier) return { ...out, verdict: 'UNKNOWN', actual: null,
    reason: `unknown predicate '${predicate}' — the vocabulary is closed (${PROBE_PREDICATES.join(', ')})` };
  if (tier === 'all' && level !== 'all') {
    return { ...out, verdict: 'UNKNOWN', actual: null, reason: `predicate '${predicate}' needs MEMORY_PROBE_LEVEL=all (current: ${level})` };
  }
  if (out.expected == null || String(out.expected) === '') {
    return { ...out, verdict: 'UNKNOWN', actual: null, reason: 'probe has no probe_expected — nothing to compare against' };
  }

  const t0 = Date.now();
  try {
    const fn = PREDICATES[tier][predicate];
    const actual = await Promise.race([
      fn(args),
      new Promise((_, rej) => setTimeout(() => rej(new Refusal('probe timeout')), TIMEOUT_MS + 250))
    ]);
    return { ...out, ranMs: Date.now() - t0, actual,
      verdict: matchesExpected(actual, out.expected) ? 'FRESH' : 'STALE',
      reason: matchesExpected(actual, out.expected) ? undefined
        : `actual '${String(actual).slice(0, 120)}' does not match expected '${String(out.expected).slice(0, 120)}'` };
  } catch (e) {
    const ranMs = Date.now() - t0;
    if (e instanceof Unprovable) return { ...out, ranMs, verdict: 'UNPROVABLE', actual: null, reason: e.message };
    // Refusals are LOUD (warn log) and UNKNOWN — never STALE.
    if (e instanceof Refusal) { warn(`probe refused [${doc.name}]: ${e.message}`); return { ...out, ranMs, verdict: 'UNKNOWN', actual: null, reason: `REFUSED: ${e.message}` }; }
    return { ...out, ranMs, verdict: 'UNKNOWN', actual: null,
      reason: `probe error (${String(e.message || e).slice(0, 160)}) — UNKNOWN, never STALE on error` };
  }
}

/**
 * Sweep every probe-bearing doc, write the SIDECAR, return the results.
 * Memory files are never touched; a sweep failure never propagates.
 */
export async function sweepProbes(docs, { level = probeLevel(), force = false } = {}) {
  const targets = (docs || []).filter((d) => (d.probe || d.validUntil) && !d.parentName);
  const results = [];
  for (const d of targets) results.push(await runProbe(d, { level }));
  const summary = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  const payload = { at: new Date().toISOString(), level, count: results.length, summary, results };
  const path = probeResultsPath();
  if (path) {
    // BELT AND BRACES (D2). A sweep that found NO probes is a truthful result
    // about the corpus it was pointed at — and writing it over a sidecar that
    // holds real verdicts turns off probe surfacing everywhere until someone
    // notices. That is precisely what happened: the suite's fixture-corpus
    // dream spawn wrote count:0 over a live count:4, and two readers reached
    // opposite conclusions about whether the feature works. A zero-probe sweep
    // now refuses to clobber a non-empty sidecar unless explicitly forced.
    let blocked = null;
    if (!force && !results.length) {
      try {
        const prior = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(prior.results) && prior.results.length) {
          blocked = `refused to overwrite ${prior.results.length} verdict(s) in ${path} with a zero-probe sweep` +
            ' — point MEMORY_PROBE_RESULTS at a sandbox, or pass force:true if you mean it';
        }
      } catch (_) { /* unreadable or absent prior = nothing to protect */ }
    }
    if (blocked) { warn('probe sweep: ' + blocked); return { ...payload, sidecarWrite: 'refused', reason: blocked }; }
    try { writeFileSync(path, JSON.stringify(payload, null, 1) + '\n', 'utf8'); }
    catch (e) { warn('probe sidecar write failed: ' + e.message); }
  }
  return payload;
}

export function readProbeResults() {
  const path = probeResultsPath();
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (_) { return null; }
}
