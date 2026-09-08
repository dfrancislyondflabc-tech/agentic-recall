// lib/version.js — WHICH BUILD OF THIS SERVER IS ANSWERING.
//
// Node caches every module at spawn time. An MCP server that Claude Desktop
// started this morning keeps running this morning's code no matter how many
// times the repo is edited, and NOTHING in a tool response used to say so — a
// session could read a fixed bug's symptom and conclude the fix does not work.
//
// So the server states its identity: the git SHA it was spawned from, the
// branch, and the moment the process started. Logged once at startup (stderr —
// stdout is the JSON-RPC channel) and stamped on every search response, which
// makes "the running process is older than the code" a one-glance diagnosis
// instead of an afternoon.
//
// The SHA is read from .git directly rather than by spawning `git`: this runs
// inside an MCP stdio server, and a child process on a hot path is both slower
// and a way to break the protocol. Read once, cached — the SHA of a RUNNING
// process cannot change, and pretending otherwise would be the same lie this
// module exists to prevent.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.js';

// 🟥 THE CODE ROOT, WHICH IS NOT THE DATA ROOT (MEM-49 / A-D4, campaign A, 2026-09-05).
//
// Everything in this file answers "which build of this server is answering", and that is a
// question about CODE. It used to be answered from `config.ROOT`, which is the DATA root:
// MEMORY_ROOT points a released copy (dist/capture, scripts/release-capture.sh) at the repo's
// store, indexes and model cache, and lib/scheduler.js keeps CODE_ROOT and DATA_ROOT apart for
// exactly that reason. With MEMORY_ROOT set, `join(ROOT,'package.json')` named a file that is not
// there, so `packageVersion` was null and the server introduced itself as:
//
//   initialize -> serverInfo.version "0.0.0"        (index.js:41, `packageVersion || '0.0.0'`)
//   every response -> serverVersion "@unknown-sha(no-git)"
//
// which is the same drift the handshake change was made to END ("hardcoded 1.1.0 while
// package.json said 1.6.3"). Reproduced: `MEMORY_ROOT=/tmp` -> packageVersion null; without it
// -> 1.7.1. `.git`, `.build-stamp.json` and `package.json` all ship with the CODE and are read
// from here; ROOT keeps every DATA path and is still reported by the banner, labelled.
const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where the CODE lives. Exported so a test can assert it is not `config.ROOT`. */
export const VERSION_CODE_ROOT = CODE_ROOT;

/** The instant this module was loaded — i.e. when the server process began. */
export const SERVER_STARTED_AT = new Date().toISOString();
export const SERVER_STARTED_MS = Date.now();

let CACHED = null;

/** Resolve `.git` to a directory. In a linked WORKTREE or a submodule it is a FILE holding
 *  `gitdir: <path>`, and reading `join('.git','HEAD')` from it returned null — so a server run
 *  from a worktree reported no SHA at all, which reads as "hand-assembled tree" rather than
 *  "checkout". One indirection, and a relative pointer resolves against the .git file's own dir. */
function resolveGitDir(root) {
  const dot = join(root, '.git');
  let st; try { st = statSync(dot); } catch { return null; }
  if (st.isDirectory()) return dot;
  if (!st.isFile()) return null;
  const m = readFileSync(dot, 'utf8').match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const target = m[1];
  return isAbsolute(target) ? target : resolve(root, target);
}

function readGitHead(gitDir) {
  if (!gitDir) return null;
  const headFile = join(gitDir, 'HEAD');
  if (!existsSync(headFile)) return null;
  const head = readFileSync(headFile, 'utf8').trim();

  // Detached HEAD: the file holds the SHA itself.
  if (/^[0-9a-f]{40}$/i.test(head)) return { sha: head, branch: '(detached)' };

  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return null;
  const ref = m[1].trim();
  const branch = ref.replace(/^refs\/heads\//, '');

  const looseRef = join(gitDir, ref);
  if (existsSync(looseRef)) {
    const sha = readFileSync(looseRef, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return { sha, branch };
  }

  // A linked worktree keeps HEAD in its own gitdir but its refs in the SHARED one, named by
  // `commondir`. Without this the branch is known and the SHA is not, which is the worst of the
  // two answers: a name with nothing behind it.
  let common = null;
  try {
    const raw = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (raw) common = isAbsolute(raw) ? raw : resolve(gitDir, raw);
  } catch (_) { /* an ordinary checkout has no commondir */ }
  if (common) {
    const sharedRef = join(common, ref);
    if (existsSync(sharedRef)) {
      const sha = readFileSync(sharedRef, 'utf8').trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return { sha, branch };
    }
  }

  // Packed refs: the loose file is absent after `git pack-refs`.
  for (const dir of [gitDir, common].filter(Boolean)) {
    const packed = join(dir, 'packed-refs');
    if (!existsSync(packed)) continue;
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return { sha, branch };
    }
  }
  return { sha: null, branch };
}

/** A SHA recorded AT PACKAGE TIME, for installs that have no .git.
 *
 * This is not a guess dressed as a fact: build-public-tree.sh knows exactly which commit
 * it exported and writes it down. Git is still tried FIRST, so a clone always reports its
 * real live HEAD and a stamp can never mask it. The two are reported differently —
 * `(main)` vs `(packaged)` — because "the branch I am on" and "the commit I was cut from"
 * are different claims and a reader must be able to tell which one they are being given.
 */
function readBuildStamp(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, '.build-stamp.json'), 'utf8'));
    const sha = String(raw.sha || '');
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return { sha, builtAt: raw.builtAt || null };
  } catch (_) { /* absent or malformed: fall through to honest ignorance */ }
  return null;
}

/**
 * { sha, shaShort, branch, source, builtAt, startedAt, pid, packageVersion }
 * `sha` is null only when there is neither a readable .git NOR a build stamp — a copied
 * tree someone assembled by hand. Reported honestly rather than guessed.
 * `source` is 'git' | 'packaged' | null, and it is the field that says how much the SHA
 * is worth: 'git' is the live HEAD, 'packaged' is where the tree was cut from.
 */
export function serverVersion() {
  if (CACHED) return CACHED;
  // CODE_ROOT, never ROOT — see the comment at the top of this file (MEM-49).
  let git = null;
  try { git = readGitHead(resolveGitDir(CODE_ROOT)); } catch (_) { git = null; }

  // Only when git cannot answer. A checkout's live HEAD always outranks a stamp.
  const stamp = git?.sha ? null : readBuildStamp(CODE_ROOT);

  let packageVersion = null;
  try {
    packageVersion = JSON.parse(readFileSync(join(CODE_ROOT, 'package.json'), 'utf8')).version || null;
  } catch (_) { /* not fatal */ }

  const sha = git?.sha || stamp?.sha || null;
  CACHED = {
    sha,
    shaShort: sha ? sha.slice(0, 7) : null,
    branch: git?.branch || null,
    source: git?.sha ? 'git' : (stamp ? 'packaged' : null),
    builtAt: stamp?.builtAt || null,
    packageVersion,
    startedAt: SERVER_STARTED_AT,
    pid: process.pid
  };
  return CACHED;
}

/** The compact form stamped on responses: `1.1.0@dfe2357(main)`, `1.1.0@6baf308(packaged)`,
 *  or `1.1.0@unknown-sha(no-git)` when neither source exists — the last one says WHY it is
 *  unknown, because a bare "unknown" reads like a bug rather than an install shape. */
export function serverVersionString() {
  const v = serverVersion();
  const parts = [];
  if (v.packageVersion) parts.push(v.packageVersion);
  parts.push(v.shaShort ? `@${v.shaShort}` : '@unknown-sha');
  parts.push(`(${v.branch || (v.source === 'packaged' ? 'packaged' : 'no-git')})`);
  return parts.join('');
}

/** One stderr line at startup, so a stale process is visible in the log too. */
export function versionBanner() {
  const v = serverVersion();
  // BOTH roots, labelled. They are the same on a checkout and they differ on a released copy —
  // which is the case where "root=" alone was the misleading half of the line.
  return `server build: ${serverVersionString()} pid=${v.pid} startedAt=${v.startedAt} ` +
         `code=${CODE_ROOT} data=${ROOT} — ` +
         'a RUNNING MCP process keeps the code it was spawned with; quit and relaunch the client after editing this repo';
}
