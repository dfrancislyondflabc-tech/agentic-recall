// lib/bm25.js — Okapi BM25 over title + description + headings + BODY.
//
// v1.1: the body is in. Before, the keyword leg saw only the human-written
// summary fields, so a distinctive phrase living in a body paragraph — the
// thing `grep` is best in the world at — had to be recovered by the dense leg,
// which is structurally the wrong tool for a literal string. That cost the
// benchmark's V1 and V6 outright.
//
// Field weighting is done by weighting term frequencies, not by repeating text,
// so document length stays honest — and now that the body is included, that
// honesty does real work: BM25's own length normalisation is what stops a
// 616 KB changelog from matching everything (see RETRIEVAL.fieldWeights.body).

import { RETRIEVAL } from './config.js';
import { unchunkBody } from './embed.js';

const STOP = new Set([
  'a','an','and','are','as','at','be','but','by','do','does','for','from','how','i','if','in','into','is','it','its',
  'my','of','on','or','that','the','then','there','these','this','to','was','what','when','where','which','who','will',
  'with','you','your','me','we','can','should','would','about','use','using'
]);

/**
 * Very light suffix stripping. Not a real stemmer — just enough that a query
 * saying "escalate" finds a description that says "escalates", which is the
 * single most common BM25 miss on this corpus. Deliberately conservative:
 * only pure-alpha tokens, only above a length floor, so slugs and part numbers
 * (ACME-464U, v1.2.0, bge-small) survive untouched.
 */
function stem(t) {
  if (t.length < 5 || !/^[a-z]+$/.test(t)) return t;
  if (t.endsWith('ies') && t.length > 5) return t.slice(0, -3) + 'y';
  if (t.endsWith('sses') || t.endsWith('shes') || t.endsWith('ches')) return t.slice(0, -2);
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('es') && t.length > 5) return t.slice(0, -1);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[`*_~>#|]/g, ' ')
    .split(/[^a-z0-9.+/-]+/)
    .flatMap((t) => {
      const clean = t.replace(/^[.\-/+]+|[.\-/+]+$/g, '');
      if (!clean) return [];
      // Keep the compound (v1.2.0, bge-small, chat-watcher) AND its parts —
      // this corpus is full of hyphenated slugs and dotted versions.
      const parts = clean.split(/[.\-/]/).filter((p) => p.length > 1);
      return parts.length > 1 ? [clean, ...parts] : [clean];
    })
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/**
 * Tokenise WITH character offsets, so a matched term can be pointed at in the
 * original text. Same token stream as tokenize() — including the compound-plus-
 * parts expansion — with every token carrying the span of the compound it came
 * from, which is what makes `sidebar-row` and `sidebar` highlight the same
 * eleven characters.
 */
export function tokenizePositions(text) {
  const s = String(text || '');
  const out = [];
  const re = /[a-zA-Z0-9.+/-]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const rawStart = m.index;
    const raw = m[0];
    const lead = raw.match(/^[.\-/+]+/)?.[0].length || 0;
    const clean = raw.replace(/^[.\-/+]+|[.\-/+]+$/g, '').toLowerCase();
    if (!clean) continue;
    const start = rawStart + lead;
    const end = start + clean.length;
    const parts = clean.split(/[.\-/]/).filter((p) => p.length > 1);
    const forms = parts.length > 1 ? [clean, ...parts] : [clean];
    for (const f of forms) {
      if (f.length <= 1 || STOP.has(f)) continue;
      out.push({ term: stem(f), start, end });
    }
  }
  return out;
}

/**
 * BM25F — three field groups, each length-normalised against its OWN average.
 *
 *     w̃tf   = Σ_groups  tf_g / (1 - b + b · len_g / avglen_g)
 *     score = Σ_terms    idf · w̃tf · (k1+1) / (k1 + w̃tf)
 *
 * v1.0 lumped name + description + headings into one group normalised by their
 * combined length. That was survivable while the group was small, but it hides
 * a real bug that adding the body brings into the open: heading count scales
 * with document size, so in a long document the TITLE gets normalised by the
 * length of 263 headings it has nothing to do with.
 *
 * Measured: `project-changelog` has 263 headings, giving it a lumped
 * summary length of 6,310 against a corpus average of 277. Its own name scored
 * 3.30 raw on the query "sibling app changelog" — behind five documents
 * that merely mention the words. It was literally unreachable by its own title,
 * in v1.0 too; nobody noticed because the dense leg's chunk-count advantage was
 * handing it a top-3 slot on 21 of 32 probes anyway. Take that away (see
 * RETRIEVAL.longDoc) and the flaw is load-bearing.
 *
 *   title    name + description  — bounded-length, human-authored labels
 *   headings the heading list    — grows with the document
 *   body     the text            — grows with the document
 *
 * Field weights are folded into tf at accumulation time, so a name hit is worth
 * ten body hits before saturation. Setting fieldWeights.body to 0 leaves the
 * keyword leg reading exactly the fields v1.0 read, which is what makes this
 * change bisectable.
 */
const GROUPS = ['title', 'headings', 'body'];

export function buildBm25(docs) {
  const { fieldWeights } = RETRIEVAL;
  const postings = new Map();   // term -> Map(docIdx -> [titleTf, headingTf, bodyTf])
  const lengths = GROUPS.map(() => new Float64Array(docs.length));

  docs.forEach((doc, i) => {
    const tf = GROUPS.map(() => new Map());
    const add = (g, text, weight) => {
      if (!weight) return;
      for (const t of tokenize(text)) {
        tf[g].set(t, (tf[g].get(t) || 0) + weight);
        lengths[g][i] += weight;
      }
    };
    add(0, doc.name.replace(/[-_]/g, ' ') + ' ' + doc.name, fieldWeights.name);
    add(0, doc.description, fieldWeights.description);
    add(1, doc.headings.join(' \n '), fieldWeights.headings);
    // PHASE 4b -- KEY FACTS ride in the headings group, at their own weight.
    // Same field family for the same reason: a short, hand-written line ABOUT
    // the document, length-normalised against other short lines rather than
    // against six thousand words of body. Absent (and weightless) unless a
    // sidecar supplied them.
    if (doc.keyFacts && doc.keyFacts.length) add(1, doc.keyFacts.join(' \n '), fieldWeights.keyFacts);
    // The body, de-overlapped back out of the stored chunks.
    add(2, bodyOf(doc), fieldWeights.body);

    const terms = new Set();
    for (const m of tf) for (const t of m.keys()) terms.add(t);
    for (const term of terms) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(i, tf.map((m) => m.get(term) || 0));
    }
  });

  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const avgLengths = lengths.map((a) => mean(a) || 1);
  return {
    postings, lengths, avgLengths, groups: GROUPS,
    n: docs.length,
    // ---- IDF COUNTS DOCUMENTS. A SECTION IS NOT A DOCUMENT. ----
    //
    // `n` is index ROWS, and with section children a single 635 KB document
    // contributes 138 of them. Two things then drift at once: df inflates for
    // every term that document contains, and `missingIdf = idfOf(0)` -- the
    // weight given to a term present NOWHERE -- grows with n. The second is
    // what bites. Measured: turning sections on took the corpus from 134 rows
    // to 345 and pushed `orphanShare` for one gold query from under the floor
    // to 0.5326 against a floor of 0.40, so a CORRECT answer scoring 0.680
    // (better than the 0.569 it scores without sections) was withheld as
    // "no strong match". The ranking was never the problem.
    //
    // So IDF is computed over distinct SOURCE FILES. Parent and children share
    // a file, so they count once.
    //
    // 🟥 This is a strict no-op without sections: one file per doc makes
    // docFile a bijection, nDocs === n, and dfOf === posting.size exactly.
    docFile: (() => {
      const ids = new Map();
      const arr = new Int32Array(docs.length);
      docs.forEach((d, i) => {
        const key = d.file || d.name;
        if (!ids.has(key)) ids.set(key, ids.size);
        arr[i] = ids.get(key);
      });
      arr.distinct = ids.size;
      return arr;
    })(),
    avgdl: avgLengths.reduce((a, b) => a + b, 0)   // legacy single-group view, diagnostics only
  };
}

/**
 * The body text of an indexed doc, cached on the doc object. Index entries are
 * plain JSON parsed once per process, so a non-enumerable cache field on them
 * lives exactly as long as the loaded index and dies with it.
 */
export function bodyOf(doc) {
  if (doc.__body === undefined) {
    Object.defineProperty(doc, '__body', {
      value: unchunkBody((doc.chunks || []).map((c) => c.text)),
      enumerable: false, writable: true, configurable: true
    });
  }
  return doc.__body;
}

/**
 * The score a hypothetical PERFECT document would earn for this query: every
 * distinct query term present in the corpus, matched at full term frequency
 * (tf-norm saturates at k1+1). Query terms absent from the corpus are
 * unmatchable by anyone, so they are excluded rather than counted as a miss.
 *
 * This is the denominator that makes "how much of this query did the document
 * actually answer?" comparable ACROSS queries — unlike the raw score, which
 * grows with query length and term rarity. Used by the absolute keyword scale
 * in search.js; on its own it is scale-free, which is exactly the property the
 * per-query-max normalisation destroyed.
 */
export function queryIdealScore(model, query) {
  return queryTermStats(model, query).ideal;
}

/**
 * Everything the query's own vocabulary can tell us, computed once.
 *
 *   ideal      — the score a document earns by matching every query term THAT
 *                EXISTS in the corpus, at full tf. The denominator that makes
 *                "how much of this query did the document answer?" comparable
 *                across queries.
 *   idealFull  — the same, but query terms that appear in NO document are
 *                charged the idf a df=0 term would earn instead of being
 *                dropped.
 *
 * The gap between the two is the absence signal, and it is the whole reason
 * v1.1 can say "nothing". `ideal` deliberately forgives an unmatchable term —
 * nobody can match it, so it should not be held against the documents that
 * matched everything else. But that forgiveness is exactly what let the
 * benchmark's X4 ("migrate the email database to **Postgres**") hand 0.75 to an
 * install runbook: drop the one word that made the question specific and what
 * remains — migrate, email, database — is answered perfectly by the wrong
 * document. Charging the missing term restores the fact that the distinctive
 * part of the question went unanswered.
 */
// ---- df BASIS, SHARED BY THE SCORER AND THE NORMALISER ----
// A section child shares its parent's `file`, so parent and children count as
// ONE document. Without sections this is the identity: one file per doc makes
// nDocs === model.n and dfOfModel === posting.size exactly.
export function nDocsOf(model) { return model.docFile?.distinct || model.n; }
export function dfOfModel(model, posting) {
  if (!model.docFile) return posting.size;
  const files = new Set();
  for (const i of posting.keys()) files.add(model.docFile[i]);
  return files.size;
}

export function queryTermStats(model, query) {
  const { k1 } = RETRIEVAL.bm25;
  // Documents, not rows -- see the docFile note in buildBm25.
  const nDocs = nDocsOf(model);
  const dfOf = (posting) => dfOfModel(model, posting);
  const idfOf = (df) => Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
  const missingIdf = idfOf(0);
  const terms = [...new Set(tokenize(query))];
  const present = [], absent = [], orphans = [];
  let ideal = 0, idealFull = 0, orphanIdf = 0;

  for (const term of terms) {
    const posting = model.postings.get(term);
    if (posting) {
      present.push(term);
      const w = idfOf(dfOf(posting)) * (k1 + 1);
      ideal += w;
      idealFull += w;
      continue;
    }
    absent.push(term);
    idealFull += missingIdf * (k1 + 1);
    // ORPHAN: absent, and not merely the compound form of a term that IS
    // present. `de-duplication` is absent while `duplication` is present —
    // the corpus knows the concept, the query just hyphenated it, and holding
    // that against the corpus would be wrong. `kubernetes` has no such alibi.
    const hasSibling = terms.some((o) => o !== term && model.postings.has(o) && (term.includes(o) || o.includes(term)));
    if (!hasSibling) { orphans.push(term); orphanIdf += missingIdf * (k1 + 1); }
  }

  return {
    ideal, idealFull, present, absent, orphans, distinct: terms.length,
    // Share of the query's total discriminative weight that exists NOWHERE in
    // the corpus. The single cleanest absence signal measured on this corpus:
    // 0 for 28 of the benchmark's 32 probes, ≤ 0.362 across a 20-query
    // in-domain paraphrase population, and ≥ 0.426 on every one of 12
    // out-of-domain questions.
    orphanShare: idealFull > 0 ? orphanIdf / idealFull : 0
  };
}

/** Returns Map(docIdx -> score) plus the terms that actually matched. */
export function bm25Search(model, query) {
  const { k1, b } = RETRIEVAL.bm25;
  const terms = tokenize(query);
  const scores = new Map();
  const matchedTerms = new Set();
  const seen = new Set();

  for (const term of terms) {
    if (seen.has(term)) continue;                 // BM25F saturates per term, not per occurrence
    seen.add(term);
    const posting = model.postings.get(term);
    if (!posting) continue;
    matchedTerms.add(term);
    // SAME df BASIS AS queryTermStats, or the normaliser and the scorer
    // disagree. absoluteKeyword divides this raw score by `stats.ideal`; when
    // only one of the two counted distinct files, a section whose terms are
    // concentrated in ONE file had its raw idf computed low while its ideal was
    // computed high, and its keyword score collapsed from 1.000 to nothing.
    const df = dfOfModel(model, posting);
    const idf = Math.log(1 + (nDocsOf(model) - df + 0.5) / (df + 0.5));
    for (const [docIdx, tfs] of posting) {
      let wtf = 0;
      for (let g = 0; g < tfs.length; g++) {
        if (!tfs[g]) continue;
        wtf += tfs[g] / (1 - b + b * (model.lengths[g][docIdx] / model.avgLengths[g]));
      }
      if (wtf <= 0) continue;
      scores.set(docIdx, (scores.get(docIdx) || 0) + idf * wtf * (k1 + 1) / (k1 + wtf));
    }
  }
  return { scores, matchedTerms: [...matchedTerms] };
}
