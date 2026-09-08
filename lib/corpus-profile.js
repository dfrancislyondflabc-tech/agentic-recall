// lib/corpus-profile.js — what KIND of corpus is this, derived not judged.
//
// This server was built against one corpus: a software project. Several of its
// behaviours quietly assume that, and one of them is actively wrong elsewhere.
//
// The tool description tells every caller "QUERY WITH IDENTIFIERS, NOT PROSE",
// because that was measured — on a CODE corpus, where a commit SHA finds what a
// sentence cannot. Give the same server to someone whose memories are notes for a
// novel and that advice inverts: they have no SHAs, no flags, no file paths, and
// the only thing they CAN search with is prose. Stating a corpus-specific finding
// as a universal rule is how a tool misleads a new user on their first query.
//
// So the corpus declares what it is, and the guidance follows.
//
// DERIVED, NOT CLASSIFIED. Every signal below is a COUNT — how many documents
// contain a code fence, a file path, a CONSTANT_CASE token, a SHA-shaped hex run.
// No model reads a document and decides what it is "about". That matters because
// language-judgement has failed three times in this repo (a correction vocabulary
// that fired on 76% of exchanges, an unresolved-statement vocabulary at 24%, and a
// compaction-summary exclusion that sounded right and measured worse), while the
// arithmetic joins — git, ordinals, term frequency — have not failed once.
//
// The numbers are always reported alongside the verdict, so a wrong answer is
// visible and arguable rather than mysterious, and MEMORY_CORPUS_DOMAIN overrides
// it outright.

const CODE_SIGNALS = [
  ['codeFence',   /```/],
  ['filePath',    /\b[\w.-]+\/[\w.\/-]+\.(js|ts|py|json|md|sh|yml|yaml|html|css|go|rs|java)\b/],
  ['constCase',   /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/],
  ['shaLike',     /\b[0-9a-f]{7,10}\b/],
  ['flag',        /(?:^|\s)--[a-z][a-z0-9-]{2,}\b/],
  ['funcCall',    /\b[a-zA-Z_$][\w$]*\([^)]{0,40}\)/]
];

// Deliberately NOT a "book vocabulary" list. These are STRUCTURAL prose markers:
// long sentences, few symbols. Listing words like "chapter" or "character" would
// be the vocabulary trap in a new costume — and would fail on a business plan, a
// research corpus, a legal matter, or anything else nobody thought to enumerate.
function proseness(text) {
  const t = String(text || '');
  // 200 was too high: real memories are often a paragraph. Measured, a 180-char
  // business note and a 189-char research note both returned null, so an entire
  // prose corpus scored proseScore 0 and fell through to "mixed".
  if (t.length < 100) return null;
  const sentences = t.split(/[.!?]+\s/).filter((x) => x.trim().length > 20);
  if (!sentences.length) return 0;
  const avgWords = sentences.reduce((n, s) => n + s.split(/\s+/).length, 0) / sentences.length;
  const symbolShare = (t.match(/[{}()[\]<>|=;$#]/g) || []).length / t.length;
  // Long sentences, few symbols -> prose. Short lines, many symbols -> code.
  return Math.max(0, Math.min(1, (avgWords / 25) * (1 - Math.min(1, symbolShare * 40))));
}

/**
 * Derive a profile from the corpus itself.
 * Returns { domain, confidence, signals, sampled, overridden }.
 */
export function deriveProfile(docs, opts = {}) {
  const override = opts.override || process.env.MEMORY_CORPUS_DOMAIN || null;
  const list = (docs || []).filter(Boolean);
  const sample = list.length > 400 ? list.filter((_, i) => i % Math.ceil(list.length / 400) === 0) : list;

  const counts = Object.fromEntries(CODE_SIGNALS.map(([n]) => [n, 0]));
  let proseTotal = 0, proseSeen = 0;
  for (const d of sample) {
    const text = typeof d === 'string' ? d : (d.bodyText || d.body || d.description || '');
    for (const [name, re] of CODE_SIGNALS) if (re.test(text)) counts[name]++;
    const p = proseness(text);
    if (p !== null) { proseTotal += p; proseSeen++; }
  }

  const n = Math.max(1, sample.length);
  const signals = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number((v / n).toFixed(3))]));
  signals.proseScore = proseSeen ? Number((proseTotal / proseSeen).toFixed(3)) : 0;

  // A document is "codey" if it carries structural code markers. Two independent
  // markers, not one: a lone hex run is a false positive (a date, an id), and a
  // lone path can appear in any note.
  const codeScore = Number((
    (signals.codeFence * 0.30) + (signals.filePath * 0.25) + (signals.constCase * 0.15) +
    (signals.shaLike * 0.15) + (signals.flag * 0.10) + (signals.funcCall * 0.05)
  ).toFixed(3));

  // THRESHOLDS ON THE PRINCIPLE, NOT ON ONE CORPUS.
  //
  // The first version used codeScore >= 0.35, which was fitted to this repo's own
  // curated corpus (0.43) and generalised badly: on eight pre-registered corpora
  // it scored 3/8, calling real engineering notes "mixed" and prose corpora
  // "mixed" too. Measured separation across those corpora:
  //     prose  : 0, 0, 0, 0, 0, 0.017
  //     code   : 0.117, 0.183, 0.43
  // There is a clean gap, and it is an order of magnitude below where I put the
  // line. The principle is simply: code artefacts either appear in this corpus or
  // they do not. A corpus with essentially none of them is not a code corpus,
  // whatever its sentences look like — so `prose` no longer depends on proseScore,
  // which is the weaker and more fragile of the two signals.
  let domain, confidence;
  if (override) { domain = override; confidence = 1; }
  else if (codeScore >= 0.08) { domain = 'code'; confidence = Math.min(1, 0.5 + codeScore); }
  else if (codeScore <= 0.03) { domain = 'prose'; confidence = Math.min(1, 0.6 + signals.proseScore * 0.4); }
  else { domain = 'mixed'; confidence = 0.45; }

  return {
    domain, confidence: Number(confidence.toFixed(2)), codeScore, signals,
    sampled: sample.length, ofDocuments: list.length,
    overridden: Boolean(override),
    note: override
      ? `domain forced to ${override} by MEMORY_CORPUS_DOMAIN`
      : `DERIVED from ${sample.length} document(s) by counting structural markers — no document was ` +
        'read and classified. Override with MEMORY_CORPUS_DOMAIN=code|prose|mixed.'
  };
}

/**
 * The guidance that depends on the corpus, in ONE place.
 * `latest` is a literal term filter in every domain; what changes is what a caller
 * should type INTO it.
 */
// ── The category set ────────────────────────────────────────────────────────
//
// Statistics can only separate code from not-code: measured on eight corpora, a
// novel, a business plan, case notes, research notes, recipes and a book about
// software ALL score codeScore 0. They are indistinguishable by counting, and no
// amount of better counting will separate them, because the difference is one of
// SUBJECT, not of surface form.
//
// So the caller may say. `domain:` is an explicit, trusted hint — Claude reading a
// conversation knows perfectly well whether it is debugging a parser or plotting a
// novel, and that is an easy judgement, not the hard kind this repo has been burned
// by. The burns were all "infer an OUTCOME from language" (is this resolved, is
// this a correction, is this stale). Categorising subject matter is not that, and
// the cost of getting it wrong here is one line of advice text.
//
// The statistics remain the FLOOR: they need no cooperation, so a corpus someone
// just imported gets sensible advice on its very first query with nobody declaring
// anything. The hint raises the resolution when it is offered.
export const DOMAINS = ['code', 'writing', 'business', 'research', 'planning', 'prose', 'mixed'];

export function queryAdviceFor(domain) {
  if (domain === 'writing') {
    return 'QUERY WITH WHAT IS ON THE PAGE — a character or place name, a chapter title, a phrase you ' +
      'actually wrote. This is a literal string filter, so it finds the words you used, not the theme ' +
      'you meant: "Mara pier" finds the scene, "the moment she hesitates" usually finds nothing. ' +
      'For a question about theme or shape rather than wording, use action:"search", which RANKS.';
  }
  if (domain === 'business') {
    return 'QUERY WITH THE CONCRETE NOUN — a customer or company name, a metric, a number, the name of ' +
      'a deal or a document. This is a literal string filter, so "usage pricing" finds the decision ' +
      'while "how we should charge" often finds nothing. action:"search" ranks and is better for a ' +
      'question you can only phrase as a question.';
  }
  if (domain === 'research') {
    return 'QUERY WITH THE TERM OF ART — an author, a dataset, a measure, a specific finding. This is a ' +
      'literal string filter over what you wrote, not over the literature. action:"search" ranks and ' +
      'suits a question about an argument rather than a term.';
  }
  if (domain === 'planning') {
    return 'QUERY WITH THE THING ITSELF — a person, a date, a project or task name. This is a literal ' +
      'string filter. For "what was I going to do about X", action:"latest" ordered NEWEST FIRST is ' +
      'usually what you want, because plans are superseded rather than corrected.';
  }
  if (domain === 'prose') {
    return 'QUERY WITH DISTINCTIVE WORDS — names, titles, places, a phrase you actually wrote. ' +
      'This is a literal string filter, so it matches what is on the page, not what you mean: ' +
      'a character name or a chapter title finds far more than a description of a theme. ' +
      'If a filter returns nothing, drop your least distinctive word and retry, or use ' +
      'action:"search", which RANKS instead of filtering and is the better default for prose.';
  }
  if (domain === 'code') {
    return 'QUERY WITH IDENTIFIERS, NOT PROSE — a commit SHA, file name, flag, function name, error ' +
      'string or exact number finds what a natural-language phrasing cannot. Measured on this kind ' +
      'of corpus: "pushed commit with failing test semicolon" returned nothing while "pushed c509e0f" ' +
      'returned the answer immediately. Prose belongs in action:"search", which ranks.';
  }
  return 'QUERY WITH WHATEVER IS MOST DISTINCTIVE — an identifier if the memory is technical, a name ' +
    'or exact phrase if it is prose. This is a literal string filter either way, so type what would ' +
    'actually appear on the page. action:"search" ranks instead of filtering.';
}

/** Is claim-verification against source artefacts meaningful for this corpus? */
export function verificationAppliesTo(domain) {
  return domain === 'code' || domain === 'mixed';
}

// ── Which advice applies to THIS call ───────────────────────────────────────
//
// The corpus profile is one number for a whole corpus, and a real corpus is often
// mixed — this server's own staging corpus derives `mixed` at 0.4, because
// transcripts are half prose and half code. One answer cannot serve every query
// inside it.
//
// The strongest per-call signal is the QUERY, which the tool already holds. A
// query carrying a SHA, a path, a CONSTANT_CASE name or a --flag is a technical
// retrieval whatever the corpus is; a query of ordinary words is not.
//
// Note what this deliberately does NOT do: ask the caller to declare the task and
// then trust the answer. A self-report cannot be checked, and this server's whole
// argument is that measurement beats assertion. The query is data; a claim about
// intent is not. An explicit `domain:` argument is still honoured when given —
// believing someone who tells you outright is different from requiring them to.
const QUERY_CODE_SHAPES = [
  /\b[0-9a-f]{7,40}\b/,                                   // a SHA
  /\b[\w.-]+\/[\w.\/-]+\.[a-z]{1,5}\b/,                    // a path
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/,                     // CONSTANT_CASE
  /(?:^|\s)--[a-z][a-z0-9-]{2,}\b/,                        // a --flag
  /\b[a-z][\w$]*\(\)/                                      // a function call
];

export function queryLooksTechnical(query) {
  const q = String(query || '');
  return QUERY_CODE_SHAPES.some((re) => re.test(q));
}

/**
 * Resolve the advice for one call.
 * Authority: explicit override > query shape > corpus profile.
 */
export function adviceFor({ query, corpusDomain, override, hint } = {}) {
  // A caller who names the domain is believed. This is the ONLY way to get
  // writing/business/research/planning apart — counting cannot do it.
  const declared = override || hint;
  if (declared && DOMAINS.includes(declared)) {
    return { domain: declared, basis: override ? 'explicit override' : 'caller-supplied domain', advice: queryAdviceFor(declared) };
  }
  if (queryLooksTechnical(query)) {
    return { domain: 'code', basis: 'this query carries an identifier', advice: queryAdviceFor('code') };
  }
  // No technical shape in the query. In a code corpus that is worth SAYING —
  // it is the single most common reason a search here comes back empty.
  if (corpusDomain === 'code') {
    return {
      domain: 'code', basis: 'corpus profile (query carried no identifier)',
      advice: queryAdviceFor('code')
    };
  }
  return {
    domain: corpusDomain === 'prose' ? 'prose' : 'mixed',
    basis: 'corpus profile',
    advice: queryAdviceFor(corpusDomain === 'prose' ? 'prose' : 'mixed')
  };
}
