#!/usr/bin/env node
// scripts/build-index.js — CLI index builder.  npm run index [-- --force]

import { buildAllIndexes } from '../lib/index-store.js';
import { log } from '../lib/logger.js';

const force = process.argv.includes('--force');

const reports = await buildAllIndexes({ force });
const report = reports[0];   // curated, for the summary below

// `corpusDir` is the ROOT LIST, not a string. Template-stringifying it printed
// `corpus         : [object Object]` -- in the very first command the README tells a stranger to
// run, which reads like a broken install.
const rootDirs = (Array.isArray(report.corpusDir) ? report.corpusDir : [report.corpusDir])
  .map((r) => (typeof r === 'string' ? r : r && r.dir)).filter(Boolean);

log('--- index report ---');
log(`corpus         : ${rootDirs.join(', ') || '(none configured)'}`);
log(`files indexed  : ${report.filesIndexed}`);
log(`files excluded : ${report.filesExcluded}` +
    (report.excluded.length ? ` (${report.excluded.map((e) => `${e.file} [${e.reason}]`).join(', ')})` : ''));
// EMPTY FILES ARE NOT EXCLUDED FILES (MEM-56): nothing was refused, there was nothing there. Only
// printed when it happened, so an ordinary report is unchanged.
if (report.filesSkippedEmpty) log(`files skipped  : ${report.filesSkippedEmpty} empty (${report.skipped.names.join(', ')})`);
for (const s of report.sectionsScrubbed) log(`section scrub  : ${s.file} → removed ${s.sections.join(', ')}`);
log(`chunks         : ${report.chunkCount}`);
log(`reused / new   : ${report.filesReused} / ${report.filesEmbedded}`);
log(`dense enabled  : ${report.denseEnabled}${report.denseEnabled ? '' : ' — ' + report.denseDisabledReason}`);
log(`build seconds  : ${report.buildSeconds}`);
log(`index size     : ${(report.indexBytes / 1e6).toFixed(2)} MB  (${report.indexPath})`);

// 🟥 INDEXING NOTHING IS NOT SUCCESS. Two different situations, and only one is an error:
//
//   a root that DOES NOT EXIST  -> a misconfiguration. Say so, name the path and the setting that
//                                  points at it, and exit non-zero.
//   roots present but empty     -> legitimate on a fresh install (021f481). Warn, exit 0.
//
// Before this, both printed `files indexed: 0` and exited 0 with nothing else said.
const missing = report.missingRoots || [];
if (missing.length) {
  log('');
  log('*** MEMORY ROOT NOT FOUND — nothing was indexed from it ***');
  for (const m of missing) log(`    ${m}`);
  log('    Check "memoryDir" in your MCP server config, or the MEMORY_DIR environment variable.');
  log('    The path above does not exist, so this index is empty for that root.');
  process.exitCode = 1;
} else if (report.filesIndexed === 0) {
  log('');
  log('*** WARNING: 0 files indexed. The configured root(s) exist but contain no memories. ***');
  log('    This is expected on a fresh install. Write a .md memory and run this again.');
}
