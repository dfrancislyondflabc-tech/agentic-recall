#!/usr/bin/env node
// scripts/mine-currency-candidates.js — surface dated key/value collisions in
// the curated corpus, as CANDIDATES for the currency gold set.
//
//   node scripts/mine-currency-candidates.js [--max N]
//
// READ-ONLY over the curated memory folder. This does not label anything: it
// mines the corpus's own markers — version tokens, 🟥/✅ transition lines,
// "corrected/fixed YYYY-MM-DD", counts, superseded notes — and prints them
// grouped by file with dates, so a human (Claude, then the coordinator's
// spot-check) can adjudicate each into {question, current_value, stale_value,
// sources} with an evidence trail. Adjudication is judgment; mining is grep.

import { readFileSync } from 'node:fs';
import { loadCorpus } from '../lib/corpus.js';
import { rootsForCorpus } from '../lib/config.js';

const MAX = (() => { const i = process.argv.indexOf('--max'); return i === -1 ? 40 : parseInt(process.argv[i + 1]) || 40; })();

const MARKERS = [
  ['version-token',   /\b(?:v\d{2,3}|Mac v\d+|Win v\d+)\b/g],
  ['status-flag',     /^.*(?:🟥|✅|⚠️).*$/gm],
  ['dated-correction', /^.*\b(?:corrected|fixed|superseded|updated|changed|ruled|shipped|landed|as of)\b.*\b20\d\d-\d\d(?:-\d\d)?\b.*$/gim],
  ['count-claim',     /^.*\b\d{1,6}\s+(?:files?|docs?|documents?|memories|entries|commits?|chunks?|tests?|cases?|rows?|models?|dirs?|directories|roots?|probes?|barges?)\b.*$/gim],
  ['port-or-flag',    /^.*\b(?:port\s+\d{4,5}|:\d{4,5}\b|MEMORY_[A-Z_]+|EB_[A-Z_]+|QSB_[A-Z_]+).*$/gm]
];

const { docs } = loadCorpus(rootsForCorpus('curated'));
const report = [];
for (const d of docs) {
  const body = String(d.body || '');
  const hits = [];
  for (const [kind, re] of MARKERS) {
    re.lastIndex = 0;
    const m = [...body.matchAll(re)].slice(0, 8);
    for (const x of m) {
      const line = (x[0].length > 4 ? x[0] : bodyLineAround(body, x.index)).trim().slice(0, 160);
      hits.push({ kind, line });
    }
  }
  if (!hits.length) continue;
  // A collision needs at least two versions/dates/states in the SAME file (or
  // a version token that a sibling file supersedes) — files with a single
  // marker rarely hold both a current and a stale value.
  const versions = new Set((body.match(/\bv(\d{2,3})\b/g) || []));
  report.push({ file: d.file, name: d.name, markers: hits.length, versions: [...versions].slice(0, 10), hits });
}

function bodyLineAround(body, i) {
  const s = body.lastIndexOf('\n', i) + 1;
  let e = body.indexOf('\n', i); if (e === -1) e = body.length;
  return body.slice(s, e);
}

report.sort((a, b) => b.markers - a.markers);
console.log(`curated files with currency markers: ${report.length} (showing top ${MAX})\n`);
for (const r of report.slice(0, MAX)) {
  console.log(`== ${r.name}  (${r.markers} markers${r.versions.length ? '; versions ' + r.versions.join(',') : ''})`);
  const seen = new Set();
  for (const h of r.hits.slice(0, 10)) {
    const key = h.line;
    if (seen.has(key)) continue; seen.add(key);
    console.log(`   [${h.kind}] ${h.line}`);
  }
  console.log('');
}
