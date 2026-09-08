// lib/orphan-handoffs.js — the smoke alarm for handoff documents that fell
// one directory short of being findable.
//
// THE FAILURE THIS CATCHES HAPPENED THREE TIMES BEFORE IT WAS NOTICED. The
// handoff scan is flat by design (lib/config.js: "a nested handoff home must
// be listed, not found"), so a session that writes HANDOFF-*.md into a
// SUBDIRECTORY of a configured root has produced a document that looks filed
// and is invisible — no query can reach it, and nothing said so. The 08-22 BoM
// campaign, the 08-26 memory campaign, and local-server-app-patterns all sat
// in exactly that state until a human stumbled on them.
//
// This module does NOT widen the scan. Recursive ingestion was considered and
// rejected when the roots were designed: a deep tree under Projects holds
// checkouts, node_modules, build output — walking it would be slow and would
// index other projects' files. The flat rule stays; what was missing is the
// ALARM. Look exactly ONE level below each root — the level a mis-filed
// handoff actually lands on — and WARN. Never ingest, never move, never write.
//
// Cheap by construction: a few dozen readdirs, cached in-process for a minute
// so a burst of searches pays once. Never throws — an unreadable directory is
// somebody else's permissions problem, not a reason to fail a search.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HANDOFF_PATTERNS, handoffDirs } from './config.js';

// Directory names that hold machine output, not documents. A HANDOFF-*.md
// inside node_modules is somebody's shipped test fixture, not a lost handoff.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'store']);

const TTL_MS = 60_000;
let CACHE = null;    // { at, key, orphans }

/**
 * Absolute paths of handoff-pattern files sitting in an immediate subdirectory
 * of a configured handoff root — matching the patterns, and unreachable.
 * Depth exactly 1, never deeper: the flat scan covers depth 0, and a document
 * two levels down is filed under some other project's structure, not mis-filed
 * under ours.
 */
export function orphanHandoffs({ force = false } = {}) {
  // The cache is keyed by the ROOT LIST, not just by time: MEMORY_HANDOFF_DIRS
  // can change between calls (tests do exactly this), and serving one root
  // set's scan against another's is a stale answer wearing a fresh timestamp.
  let roots;
  try { roots = handoffDirs(); } catch { roots = []; }
  const key = roots.join('\n');
  if (!force && CACHE && CACHE.key === key && Date.now() - CACHE.at < TTL_MS) return CACHE.orphans;
  const orphans = [];
  try {
    const rootSet = new Set(roots);
    for (const root of roots) {
      let entries;
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (SKIP_DIRS.has(e.name)) continue;
        const sub = join(root, e.name);
        // A subdirectory that is ITSELF a configured root is covered by the
        // real scan — example-bot and notes both live
        // inside Projects, and reporting their contents as orphans would be
        // the alarm crying about the two places that are actually wired up.
        if (rootSet.has(sub)) continue;
        let files;
        try { files = readdirSync(sub, { withFileTypes: true }); } catch { continue; }
        for (const f of files) {
          if (!f.isFile()) continue;
          if (HANDOFF_PATTERNS.some((re) => re.test(f.name))) orphans.push(join(sub, f.name));
        }
      }
    }
  } catch { /* the alarm must never take a search down with it */ }
  CACHE = { at: Date.now(), key, orphans };
  return orphans;
}

/**
 * The same finding, phrased for a guidance[] array: one line per orphan,
 * naming the path and the two fixes. Never throws, returns [] when quiet.
 */
export function orphanHandoffLines(opts = {}) {
  try {
    return orphanHandoffs(opts).map((p) =>
      `ORPHAN HANDOFF — ${p} matches the handoff patterns but sits one level BELOW a configured ` +
      'root, and the scan is flat by design, so NO QUERY CAN REACH IT. Move it into the root, or ' +
      'add its directory to MEMORY_HANDOFF_DIRS / DEFAULT_HANDOFF_DIRS (lib/config.js).');
  } catch { return []; }
}
