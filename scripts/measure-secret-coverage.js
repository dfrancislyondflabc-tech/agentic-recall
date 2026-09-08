#!/usr/bin/env node
// scripts/measure-secret-coverage.js — how much of a TRANSCRIPT's credential
// surface does the pattern guard actually cover?
//
//   node scripts/measure-secret-coverage.js <file.jsonl|file.md> [--show N]
//   exit 0 = no LEAK-tier candidate survived   exit 1 = at least one did
//
// WHY. The curated corpus is safe by construction: one denylisted file, one
// scrubbed section, both chosen by a human who knows what is in them.
// Auto-ingesting transcripts removes that human, which promotes the pattern
// guard (lib/secrets.js mechanism 4) from BACKSTOP to primary defence. A
// backstop promoted to primary has to be measured before it is trusted.
//
// METHOD. Two independent readings of the same text: what redact() actually
// removes, and what a broader detector battery finds. The number that matters
// is the DIFFERENCE — a candidate the detectors find that survives redaction.
//
// TWO DETECTOR TIERS, because the first run of this script taught the lesson:
//   leak   — the shape carries a secret VALUE. Survival is a real finding.
//   review — the shape is ambiguous (a 40-char hex is far more often a git SHA
//            than a token). Survival needs eyes, not an alarm.
// A detector must match the VALUE, never the prefix: `sshpass -p` on its own
// survives redaction by design (the replacement keeps the prefix and swaps the
// password), so a prefix detector reports a leak on text that is already safe.
// That false positive is what the first version of this script did.

import { readFileSync } from 'node:fs';
import { redact } from '../lib/secrets.js';

const file = process.argv[2];
const showN = (() => { const i = process.argv.indexOf('--show'); return i === -1 ? 12 : parseInt(process.argv[i + 1]) || 12; })();
if (!file) { console.error('usage: measure-secret-coverage.js <file> [--show N]'); process.exit(2); }

function extractText(path) {
  const raw = readFileSync(path, 'utf8');
  if (!path.endsWith('.jsonl')) return [{ where: path, text: raw }];
  const out = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const walk = (v) => {
      if (typeof v === 'string') { if (v.length) out.push({ where: `line ${lineNo}`, text: v }); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') { for (const x of Object.values(v)) walk(x); }
    };
    walk(j.message?.content); walk(j.toolUseResult);
  }
  return out;
}

const NR = String.raw`(?!\[REDACTED\])`;   // a value already redacted is not a finding
const DETECTORS = [
  { name: 'bearer-token',      tier: 'leak',   re: new RegExp(String.raw`\bBearer\s+${NR}[A-Za-z0-9._\-]{12,}`, 'gi') },
  { name: 'api-key-prefixed',  tier: 'leak',   re: /\b(?:sk|pk|ghp|gho|ghs|xoxb|xoxp|AKIA|ASIA)[-_][A-Za-z0-9]{12,}/g },
  // The header detector alone scored the header-only pattern as 100% covered while every byte of
  // key material survived (campaign B, B-1). The BODY detector is the one that matters: it matches
  // the whole block, so `red.includes(m)` is only false when the body is actually gone.
  { name: 'private-key-block', tier: 'leak',   re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'private-key-body',  tier: 'leak',   re: /-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY-----(?:\r?\n[A-Za-z0-9+/=]{16,})+/g },
  { name: 'url-userinfo',      tier: 'leak',   re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{3,}@/gi },
  { name: 'assignment-secret', tier: 'leak',   re: new RegExp(String.raw`\b(?:TOKEN|SECRET|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET)\s*[:=]\s*['"\`]?${NR}[^\s'"\`,;]{8,}`, 'gi') },
  { name: 'jwt',               tier: 'leak',   re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // VALUE-targeting, not prefix-targeting. See the header note.
  { name: 'sshpass-value',     tier: 'leak',   re: new RegExp(String.raw`sshpass\s+-p\s*['"]?${NR}[^\s'"]{3,}`, 'gi') },
  { name: 'password-value',    tier: 'leak',   re: new RegExp(String.raw`\b(?:password|passwd|pwd)\s*[:=]\s*['"\`]?${NR}[^\s'"\`,;]{3,}`, 'gi') },
  { name: 'long-hex-blob',     tier: 'review', re: /\b[0-9a-f]{40,}\b/gi },
  { name: 'base64-blob',       tier: 'review', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
];

const segments = extractText(file);
const guardPatterns = new Map();
const caught = new Map(), gaps = new Map();
let charsIn = 0, segsChanged = 0, redactions = 0;
let leakTotal = 0, leakSurvived = 0, reviewSurvived = 0;

for (const seg of segments) {
  charsIn += seg.text.length;
  const { text: red, hits } = redact(seg.text);
  if (hits.length) { segsChanged++; redactions += hits.length; for (const h of hits) guardPatterns.set(h, (guardPatterns.get(h) || 0) + 1); }

  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    const found = seg.text.match(d.re);
    if (!found) continue;
    for (const m of found) {
      if (d.tier === 'leak') leakTotal++;
      if (!red.includes(m)) { caught.set(d.name, (caught.get(d.name) || 0) + 1); continue; }
      if (d.tier === 'leak') leakSurvived++; else reviewSurvived++;
      const at = seg.text.indexOf(m);
      if (!gaps.has(d.name)) gaps.set(d.name, []);
      gaps.get(d.name).push({ tier: d.tier, match: m, ctx: seg.text.slice(Math.max(0, at - 40), at + m.length + 40).replace(/\s+/g, ' ') });
    }
  }
}

console.log(`file             : ${file}`);
console.log(`text segments    : ${segments.length}  (${(charsIn / 1e6).toFixed(2)} MB)`);
console.log(`segments redacted: ${segsChanged}   total pattern firings: ${redactions}`);
console.log(`\nLEAK-tier candidates: ${leakTotal}   caught: ${leakTotal - leakSurvived}   SURVIVED: ${leakSurvived}`);
console.log(`LEAK coverage: ${leakTotal ? (((leakTotal - leakSurvived) / leakTotal) * 100).toFixed(1) + '%' : 'n/a (none present)'}`);
console.log(`review-tier survived (needs eyes, usually benign): ${reviewSurvived}`);

console.log('\n--- what the GUARD fired on (its own pattern names) ---');
if (!guardPatterns.size) console.log('  (nothing)');
for (const [n, c] of [...guardPatterns].sort((a, b) => b[1] - a[1])) console.log('  ' + n.padEnd(28) + String(c).padStart(6));

if (gaps.size) {
  console.log(`\n--- SURVIVED redaction (up to ${showN} distinct per shape) ---`);
  for (const [name, list] of gaps) {
    const distinct = new Set(list.map((x) => x.match));
    console.log(`\n  [${list[0].tier.toUpperCase()}] ${name}  ${list.length} occurrence(s), ${distinct.size} distinct`);
    const seen = new Set();
    for (const g of list) {
      if (seen.has(g.match)) continue;
      seen.add(g.match);
      if (seen.size > showN) { console.log(`      … ${distinct.size - showN} more distinct`); break; }
      console.log(`      … ${g.ctx.slice(0, 140)}`);
    }
  }
}
process.exit(leakSurvived ? 1 : 0);
