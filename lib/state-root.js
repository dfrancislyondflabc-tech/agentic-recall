// THE STATE ROOT — where the server keeps what it WRITES: the embedding model
// cache (~35 MB), the vector cache, the built indexes, local-config.json, the
// heartbeat file and the scheduler's bookkeeping.
//
// This used to be, unconditionally, the directory the code sits in. That is the
// right answer for a git clone and the wrong one for a package install:
//
//   * `npx agentic-recall` unpacks the code into npm's DISPOSABLE cache
//     (~/.npm/_npx/<hash>). State written there is thrown away whenever npm
//     evicts it, so the 35 MB model would re-download and the whole corpus
//     would be re-embedded — minutes of work — on a schedule nobody controls.
//   * Under `npm i -g` the code lives in a shared node_modules that may not be
//     writable at all, and that `npm update` replaces wholesale.
//
// So the root is resolved once, in this order:
//
//   1. MEMORY_ROOT — an explicit override always wins. A released copy of the
//      code uses it to keep sharing a repo's data (see lib/config.js).
//   2. State that ALREADY EXISTS beside the code. Every install that predates
//      this change keeps using exactly the files it has been using, with no
//      action from anyone. This is the backward-compatibility clause and it is
//      deliberately checked before the package test.
//   3. Code unpacked under node_modules/ or npm's _npx/ — a package install.
//      Use ~/.agentic-recall, which survives eviction and update.
//   4. Otherwise the code directory. A git clone behaves as it always has.
//
// Resolved ONCE at first call and cached: five modules read it at import time
// and they must not be able to disagree with each other.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Any one of these beside the code means "this install already has state here".
const STATE_MARKERS = [
  '.model-cache',
  '.vector-cache.json',
  '.memory-index.json',
  'local-config.json',
  'store'
];

export const HOME_ROOT = join(homedir(), '.agentic-recall');

function looksLikePackageInstall(dir) {
  const parts = dir.split(sep);
  return parts.includes('node_modules') || parts.includes('_npx');
}

function hasStateBesideCode() {
  return STATE_MARKERS.some((m) => existsSync(join(CODE_ROOT, m)));
}

// 🟥 ONE CORPUS PER STATE DIRECTORY. 2.0.0 sent every package install to a single
// ~/.agentic-recall, so TWO corpora on one machine shared one index, one vector cache and one
// store — and clobbered each other. Reproduced: index corpus A, then corpus B, and A's documents
// are gone from the index. The server DETECTS it (the vanish report names what disappeared) but
// nothing prevented it, and the import instructions never mentioned MEMORY_ROOT.
//
// This was a REGRESSION introduced with this file: before it, state lived beside the code, so a
// second checkout was automatically a second state directory. Centralising the root removed that
// accidental isolation without replacing it.
//
// The slug is derived from the RAW MEMORY_DIR env var, deliberately, not from the resolved
// memoryDir(): lib/config.js computes memoryDir() FROM this root, so reading it here would be a
// cycle. Basename plus a hash of the absolute path — readable enough to identify by eye, unique
// enough that two folders with the same name do not collide.
function corpusSlug() {
  const raw = process.env.MEMORY_DIR;
  if (!raw) return null;   // no explicit corpus: the fallback lives inside the root anyway
  const abs = resolve(raw);
  const name = basename(abs).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'corpus';
  return `${name}-${createHash('sha1').update(abs).digest('hex').slice(0, 8)}`;
}

let cached = null;
let cachedShared = null;

/**
 * The root that is SHARED across corpora on this machine. Only the embedding model lives here:
 * it is ~33 MB, identical for every corpus, and re-downloading it per corpus would be a bad
 * trade for isolation nobody asked for.
 */
export function sharedRoot() {
  if (cachedShared) return cachedShared;
  if (process.env.MEMORY_ROOT) { cachedShared = resolve(process.env.MEMORY_ROOT); return cachedShared; }
  if (hasStateBesideCode() || !looksLikePackageInstall(CODE_ROOT)) { cachedShared = CODE_ROOT; return cachedShared; }
  try { mkdirSync(HOME_ROOT, { recursive: true }); } catch { cachedShared = CODE_ROOT; return cachedShared; }
  cachedShared = HOME_ROOT;
  return cachedShared;
}

export function stateRoot() {
  if (cached) return cached;

  if (process.env.MEMORY_ROOT) {
    cached = resolve(process.env.MEMORY_ROOT);
    return cached;
  }

  if (hasStateBesideCode() || !looksLikePackageInstall(CODE_ROOT)) {
    cached = CODE_ROOT;
    return cached;
  }

  // A package install with nothing of its own yet. Per corpus, so two memory folders on one
  // machine cannot share an index. mkdir here rather than at each write site: callers join onto
  // this and expect the directory to exist, and one idempotent mkdir at startup is cheaper than
  // guarding every writer.
  const slug = corpusSlug();
  const dir = slug ? join(HOME_ROOT, slug) : HOME_ROOT;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Unwritable home is not a reason to fail to start. Fall back to the code
    // directory and let the individual write fail with its own message.
    cached = CODE_ROOT;
    return cached;
  }
  cached = dir;
  return cached;
}

// Test seam. Nothing in the server calls this; the fixtures do, because the
// resolution is cached and a fixture needs to ask the question more than once.
export function _resetStateRootCache() {
  cached = null;
  cachedShared = null;
}
