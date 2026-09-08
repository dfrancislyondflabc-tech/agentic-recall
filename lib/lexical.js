// lib/lexical.js — the phrase leg: where in a body do the query's words sit
// TOGETHER, and how tightly.
//
// BM25 with the body in it (v1.1) knows a document contains every word of a
// quoted sentence. It cannot know they occur in that order, in one breath,
// rather than scattered across 600 KB — and that difference IS the difference
// between the sentence you quoted and a document that happens to use the same
// vocabulary. The 616 KB changelog contains almost every word in the corpus;
// what it does not contain is most of the corpus's SENTENCES.
//
// So: find the tightest window of body tokens covering the most distinct query
// terms, score it by coverage and density, and cut the snippet from it. One
// mechanism answers "is this the quoted line?" and "which line is it?" at once.
//
// Cost control: this runs over the RERANK SET only (the top few dozen fused
// candidates), never the whole corpus, and every document's positional token
// array is built once and cached on the loaded index entry.

import { tokenizePositions } from './bm25.js';
import { bodyOf } from './bm25.js';
import { RETRIEVAL } from './config.js';

/** Positional tokens for a doc's body, cached for the life of the loaded index. */
export function positionsOf(doc) {
  if (doc.__pos === undefined) {
    Object.defineProperty(doc, '__pos', {
      value: tokenizePositions(bodyOf(doc)),
      enumerable: false, writable: true, configurable: true
    });
  }
  return doc.__pos;
}

/**
 * Best window of body tokens for `terms`.
 *
 * Sliding window over the token stream, keeping the minimal span for each
 * distinct-count. Scored as
 *
 *     phrase = (covered / wanted)^2 * (covered / span)
 *
 * coverage SQUARED because two adjacent words out of ten are not a fifth of a
 * quote — they are a coincidence; density (covered/span) because a quote is
 * contiguous and a vocabulary overlap is not. Both factors are 1.0 only for a
 * document that contains the query's terms, all of them, side by side.
 *
 * Returns null when the body holds none of the terms.
 */
export function bestWindow(doc, terms) {
  const wanted = new Set(terms);
  if (!wanted.size) return null;

  // A PHRASE NEEDS TWO WORDS. With one term the formula below is
  // coverage^2 * (distinct/span) = 1 * 1 * (1/1) = 1.0 — a PERFECT phrase score
  // for a single word sitting on its own, because "do the query's words occur
  // together" is vacuously true when there is only one of them.
  //
  // That is not academic. MEASURED 2026-08-18: "what is the airspeed velocity of
  // an unladen swallow" has an orphanShare of 0.843 (airspe/velocity/unladen
  // appear NOWHERE), which should have tripped the absence verdict's vocabulary
  // arm on its own. It did not, because "swallow" does occur in three memories
  // ("swallow the comma", "SWALLOWS the click"), scored phrase 1.0 by itself,
  // and the arm is a conjunction: orphanShare >= floor AND topPhrase < floor.
  // One incidental word was enough to make the server answer a Monty Python
  // question with a memory about a chat-watcher speedup, at confidence "medium".
  const MIN_PHRASE_TERMS = 2;
  if (wanted.size < MIN_PHRASE_TERMS) return null;
  const pos = positionsOf(doc);
  if (!pos.length) return null;

  // Compact to just the hits, remembering their index in the token stream.
  const hits = [];
  for (let i = 0; i < pos.length; i++) {
    if (wanted.has(pos[i].term)) hits.push({ i, t: pos[i].term, start: pos[i].start, end: pos[i].end });
  }
  if (!hits.length) return null;

  // For each right edge, walk back over a bounded neighbourhood and score every
  // window ending there.
  //
  // The obvious one-pass sliding window is WRONG here and was: it only ever
  // grows its distinct set, so once every query term has been seen somewhere in
  // the document, every later window is forced to stretch back to the earliest
  // still-needed term — and a tighter window covering one term fewer is never
  // considered at all. Measured on benchmark probe V3: the true window ("works
  // in this session" ≠ done — 3 terms, span 3) was passed over for a 3-term
  // window of span 16 elsewhere in the same document, and the snippet came back
  // pointing at the wrong paragraph.
  //
  // A phrase is tight by definition, so a bounded backward walk loses nothing:
  // any window wide enough to fall outside it has a density too low to win.
  // The prune below makes that explicit — once even perfect coverage at the
  // current span cannot beat the incumbent, stop walking.
  const maxBack = Math.min(hits.length, 4 * wanted.size + 24);
  let best = null;
  for (let r = 0; r < hits.length; r++) {
    const seen = new Set();
    for (let l = r; l >= 0 && r - l < maxBack; l--) {
      seen.add(hits[l].t);
      const span = hits[r].i - hits[l].i + 1;
      const distinct = seen.size;
      const coverage = distinct / wanted.size;
      const score = coverage * coverage * (distinct / span);
      if (!best || score > best.phrase) {
        best = { phrase: score, coverage, distinct, span, charStart: hits[l].start, charEnd: hits[r].end };
      }
      // Ceiling on anything further left: full coverage at this span or wider.
      if (best && wanted.size / span <= best.phrase) break;
    }
  }
  return best;
}

/**
 * A snippet CENTRED on the match, not on the top of the document.
 *
 * The v1.0 snippet took the first 320 characters of whichever chunk had the
 * most term hits, which is why the benchmark could return the right memory and
 * still not show you the sentence you quoted (V2, V3, V5 — right document,
 * wrong 320 characters). Here the window decides where to cut, the text is
 * grown outward to sentence boundaries where cheap, and an ellipsis marks each
 * side that was cut.
 */
export function snippetAround(text, charStart, charEnd, max = RETRIEVAL.snippetChars) {
  const s = String(text || '');
  if (!s) return '';
  if (s.length <= max) return s.replace(/\s+/g, ' ').trim();

  const matchLen = charEnd - charStart;
  let from, to;
  if (matchLen >= max) { from = charStart; to = charStart + max; }
  else {
    const pad = Math.floor((max - matchLen) / 2);
    from = Math.max(0, charStart - pad);
    to = Math.min(s.length, from + max);
    from = Math.max(0, to - max);
  }

  // Prefer a sentence start just before the cut, if one is close by.
  const head = s.slice(Math.max(0, from - 120), from);
  const sentenceStart = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  if (sentenceStart !== -1 && from - (Math.max(0, from - 120) + sentenceStart + 1) < 120) {
    const cand = Math.max(0, from - 120) + sentenceStart + 1;
    if (cand < charStart) { from = cand; to = Math.min(s.length, from + max); }
  }

  let cut = s.slice(from, to);
  if (from > 0) cut = cut.replace(/^\S*\s/, '');
  if (to < s.length) cut = cut.replace(/\s\S*$/, '');
  cut = cut.replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + cut + (to < s.length ? '…' : '');
}
