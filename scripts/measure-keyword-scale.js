#!/usr/bin/env node
// scripts/measure-keyword-scale.js — where RETRIEVAL.keywordScale comes from.
//
//   node scripts/measure-keyword-scale.js
//
// The keyword leg used to be normalised by the per-query maximum, so the
// best-scoring document always came out at 1.0 and carried half the fused
// score even when nothing had really matched. Replacing that with an absolute
// scale needs reference points, and reference points have to be measured, not
// guessed. This dumps the raw BM25 distribution over four query populations
// and shows where the constants in lib/config.js sit against it.
//
// Populations:
//   A   every document's own title as the query        — genuine, strong match
//   A2  the first content words of every description   — genuine, realistic
//   B   hand-written in-domain PARAPHRASES             — the failure case
//   C   out-of-domain questions                        — must score ~0
//
// B is deliberately NOT the evaluation query set: constants derived from the
// queries you then score yourself on are fitted, not measured.
//
// Read-only. Touches the built index and nothing else, and prints document
// names and aggregate numbers only — never corpus text.

import { loadIndex } from '../lib/index-store.js';
import { buildBm25, bm25Search, queryIdealScore, tokenize } from '../lib/bm25.js';
import { RETRIEVAL } from '../lib/config.js';

const idx = loadIndex();
if (!idx.present || !idx.docs.length) {
  console.error('no index — run `npm run index` first');
  process.exit(1);
}
const docs = idx.docs;
const model = buildBm25(docs);

const A = docs.map((d) => d.name.replace(/[-_]/g, ' '));
const A2 = docs.map((d) => String(d.description || '')
  .replace(/[^A-Za-z0-9 .\-/]/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 8).join(' '));

// In-domain paraphrases: each asks about something the corpus covers, using
// none of the distinctive words the covering memory actually contains.
const B = [
  'what do I do before I stop working on a piece of code that is not finished',
  'who should be told when a buyer has not heard back from anyone here',
  'how much of a feature should I exercise before I call it verified',
  'what must I confirm after typing a value into a field on a web page',
  'where should the notes from a call begin',
  'what does it mean when he asks me to observe him doing something',
  'the buyer wants more storage bays added to a unit they already own, what can be attached',
  'why did the lookup take almost a minute and how was it made quick',
  'how do I make the stored data smaller once it grows too large',
  'how do I stop the assistant learning from text it produced itself',
  'what has to happen before anything goes out to a buyer',
  'which machine hosts the exhibition assistant and how is it refreshed',
  'what is the correct way to word an update posted to the project board',
  'how do I obtain a signed proposal document out of the vendor portal',
  'what breaks when an unescaped character lands in the one giant page script',
  'when the instructions I was given turn out to be wrong, what should I do',
  'how do I put together a priced proposal for a new opportunity',
  'what limits exist on entering values into fields with the automation tool',
  'how are repeated message bodies treated',
  'what is the right way to describe what caused a problem when writing it up'
];
const C = [
  'how do I bake sourdough bread at home',
  'what is the capital city of Peru',
  'best way to train for a marathon',
  'explain photosynthesis to a child',
  'how do I change a flat bicycle tyre',
  'what are the rules of cricket',
  'a recipe for tomato soup',
  'the history of Roman aqueducts',
  'how tall is Mount Kilimanjaro',
  'tips for learning to play the piano',
  'why do cats purr',
  'how does a refrigerator keep food cold'
];

function top1(query) {
  const { scores } = bm25Search(model, query);
  let raw = 0, arg = -1;
  for (const [i, v] of scores) if (v > raw) { raw = v; arg = i; }
  return { raw, ideal: queryIdealScore(model, query), name: arg >= 0 ? docs[arg].name : null };
}
const P = { A: A.map(top1), A2: A2.map(top1), B: B.map(top1), C: C.map(top1) };

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
function row(label, values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`  ${label.padEnd(30)} n=${String(s.length).padStart(3)}  min=${s[0].toFixed(3)}  p10=${pct(s, 0.1).toFixed(3)}  med=${pct(s, 0.5).toFixed(3)}  p90=${pct(s, 0.9).toFixed(3)}  max=${s[s.length - 1].toFixed(3)}  mean=${mean.toFixed(3)}`);
}

console.log(`corpus: ${docs.length} documents\n`);
console.log('=== raw BM25 score of the TOP-1 document, by population ===');
row('A  title-literal', P.A.map((x) => x.raw));
row('A2 description-literal', P.A2.map((x) => x.raw));
row('B  in-domain paraphrase', P.B.map((x) => x.raw));
row('C  out-of-domain', P.C.map((x) => x.raw));

console.log('\n=== coverage of the query (raw / ideal), TOP-1 document ===');
for (const k of ['A', 'A2', 'B', 'C']) row(k, P[k].map((x) => (x.ideal > 0 ? x.raw / x.ideal : 0)));

console.log('\n=== separation in raw space: share of each population at or above a threshold ===');
const genuine = [...P.A, ...P.A2].map((x) => x.raw);
const noise = [...P.B, ...P.C].map((x) => x.raw);
console.log('  threshold   genuine   noise');
for (const t of [6, 8, 10, 12, 14, 16, 20, 24]) {
  const g = genuine.filter((x) => x >= t).length / genuine.length;
  const n = noise.filter((x) => x >= t).length / noise.length;
  console.log(`  ${String(t).padStart(9)}   ${(g * 100).toFixed(0).padStart(6)}%  ${(n * 100).toFixed(0).padStart(6)}%`);
}

const { absFloor, absFull, covFloor, covFull } = RETRIEVAL.keywordScale;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const kw = (x) => {
  if (!(x.ideal > 0)) return 0;
  const floorPoint = Math.min(absFloor, covFloor * x.ideal);
  const fullPoint = Math.min(absFull, covFull * x.ideal);
  return clamp01((x.raw - floorPoint) / (fullPoint - floorPoint)) * clamp01((x.raw / x.ideal) / covFloor);
};
console.log(`\n=== resulting kw under the SHIPPING constants (absFloor=${absFloor} absFull=${absFull} covFloor=${covFloor} covFull=${covFull}) ===`);
for (const k of ['A', 'A2', 'B', 'C']) row(k, P[k].map(kw));

console.log('\n=== the documents that used to be handed kw = 1.0 on a paraphrase ===');
B.forEach((q, i) => {
  const t = P.B[i];
  console.log(`  raw=${t.raw.toFixed(2).padStart(6)}  cov=${(t.ideal ? t.raw / t.ideal : 0).toFixed(3)}  kw=${kw(t).toFixed(3)}  ${t.name}`);
});
