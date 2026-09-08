// lib/graph-spread.js — Phase 4c: the hand-authored [[wiki-link]] graph, used.
//
// Every curated memory carries links a person wrote on purpose. Retrieval has
// never read them. The experiment: after the three legs have fused, let a
// document lend a fraction of its score to the memories it is linked to.
//
// The one eternal failure this targets: "when should I escalate…" returns
// three neighbours of `verify-protocol` and not `verify-protocol` itself —
// the rank-3 document links straight to it. The graph knows the answer the
// scores could not find.
//
// THREE CONSTRAINTS, all of them there to stop this becoming a way to
// manufacture an answer:
//
//   1. ONLY A DOCUMENT ALREADY IN THE POOL CAN RECEIVE. Spreading reorders
//      what the query reached; it never introduces a document the query did
//      not reach at all.
//   2. THE RECEIVER IS GATED ON ITS OWN QUERY-SIMILARITY. Below the gate a
//      neighbour receives nothing however loudly its neighbour scored — this
//      is what makes it gated spreading rather than "whatever the popular
//      document points at".
//   3. SINGLE HOP, from a fixed top-N, computed from the PRE-SPREAD scores.
//      Every donor lends from the score it had before anyone lent to it, so
//      the result cannot depend on iteration order and a cycle cannot
//      amplify itself.
//
// The absence verdict is computed on the pre-spread ranking by its caller —
// spreading may reorder, never refuse-or-unrefuse.
//
// Flag: MEMORY_GRAPH_SPREAD. Default per the pre-registered bar in
// test/graph-spread-preregistration.md.

// ON by default since the 2026-08-28 measurement — the only Phase-4 experiment
// that met its bar, and it met it on the named win: curated gold recall 9/10 ->
// 10/10 (the escalation question, failing since before the campaign), absence
// 4/4 and the razor pair unmoved, zero regressions. Re-measured against the
// ENLARGED bar the same day (which also protects the six verbatim body-quote
// fixtures, at two clocks 45 days apart): still ON, at alpha 0.10 rather than
// the 0.15 the first bar chose. `0` disables.
// Numbers: test/graph-spread-preregistration.md.
export function graphSpreadEnabled() {
  return !['0', 'false', 'off'].includes(String(process.env.MEMORY_GRAPH_SPREAD || '').toLowerCase());
}

const num = (env, dflt) => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) ? v : dflt;
};
// SET BY THE ENLARGED BAR (2026-08-28), not by taste — and not by turning a
// knob. The first bar shipped alpha 0.15 and, with it, a regression it never
// looked at: two linked memories outranking a VERBATIM quote of the document
// that contains it. The re-pre-registration added all six (d1) body-quote
// fixtures and a second clock 45 days out, swept 18 points, and applied a
// selection rule written before the sweep (largest minimum margin, then lower
// alpha, then lower gate).
//
//   alpha 0.15  ->  quotes 5/6      REJECTED by the enlarged bar
//   alpha 0.10  ->  everything, minMargin 0.0138 at +45 days   SELECTED
//
// The trade is explicit: MRR 0.9500 -> 0.8833 (bar: > 0.850), bought back as
// verbatim recall. Numbers: test/graph-spread-preregistration.md.
export const spreadAlpha = () => num('MEMORY_GRAPH_SPREAD_ALPHA', 0.10);
export const spreadGate = () => num('MEMORY_GRAPH_SPREAD_GATE', 0.20);
export const spreadFrom = () => num('MEMORY_GRAPH_SPREAD_FROM', 10);

/**
 * @param rows   scored rows, already sorted, each { name, score, semanticScore }
 * @param linksOf  (name) -> { links: string[], backlinks: string[] }
 * Returns a NEW array, re-sorted, with `graphSpread` recorded on any row that
 * received. `rows` is not mutated: the caller keeps the pre-spread ranking for
 * the absence verdict.
 */
export function applyGraphSpread(rows, linksOf, opts = {}) {
  const alpha = opts.alpha ?? spreadAlpha();
  const gate = opts.gate ?? spreadGate();
  const from = opts.from ?? spreadFrom();
  if (!rows || rows.length < 2 || alpha <= 0) return { rows, spread: [] };

  const byName = new Map(rows.map((r) => [r.name, r]));
  const gained = new Map();   // name -> [{ from, amount }]
  for (const donor of rows.slice(0, from)) {
    const edges = linksOf(donor.name) || {};
    const seen = new Set();
    for (const target of [...(edges.links || []), ...(edges.backlinks || [])]) {
      if (target === donor.name || seen.has(target)) continue;
      seen.add(target);
      const row = byName.get(target);
      if (!row) continue;                                   // constraint 1
      if ((row.semanticScore ?? 0) < gate) continue;         // constraint 2
      const amount = alpha * donor.score;                    // constraint 3
      if (!(amount > 0)) continue;
      if (!gained.has(target)) gained.set(target, []);
      gained.get(target).push({ from: donor.name, amount });
    }
  }
  if (!gained.size) return { rows, spread: [] };

  const out = rows.map((r) => {
    const g = gained.get(r.name);
    if (!g) return r;
    const total = g.reduce((a, x) => a + x.amount, 0);
    return { ...r, score: Number((r.score + total).toFixed(4)),
      graphSpread: { received: Number(total.toFixed(4)), from: g.map((x) => x.from) } };
  });
  out.sort((a, b) => b.score - a.score);
  return { rows: out, spread: [...gained.keys()] };
}
