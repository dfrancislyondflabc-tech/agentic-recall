// lib/probe-proposals.js — Phase 3c: dream PROPOSES, a human CONFIRMS.
//
// The curated corpus is full of probe-shaped sentences: a ship tag beside its
// sha, a local endpoint someone curls to see whether the app is up, an
// absolute path to a file that must be there. Every one is a claim a machine
// could check, and none of them is checkable, because a probe only exists once
// it is written into a memory's frontmatter.
//
// This module closes exactly half of that gap, deliberately. It reads prose
// and DRAFTS the frontmatter that would check it. It does not write it and it
// does not run it:
//
//   * NOTHING here executes. No child process, no socket, no probe. This file
//     does not import lib/probes.js, and the suite pins that it never will —
//     an extractor that ran what it read would make the corpus able to execute
//     itself, which is a different and much worse product.
//   * Every proposal carries the EXACT line that produced it, so a human can
//     reject it in one read.
//   * A proposal becomes real only when a person writes `probe:` and
//     `probe_expected:` into the memory. The sweep reads frontmatter and
//     nothing else, so an unconfirmed proposal is invisible to it by
//     construction, not by policy.
//
// WHY THE RULES ARE THIS NARROW (measured, not guessed). The first draft
// accepted any command-shaped prose across all eight work roots and produced
// **1,660 proposals over 659 documents** — including an nightly GET against a
// customer PAYMENT GATEWAY, a `/tmp` scratch path from a deck build, a
// truncated `http://localhost` out of a template literal in a code fence, and
// a crowd of `mcp-windows-v77`-style CI WORKFLOW names read as ship tags. A
// queue that size is not reviewed, it is skipped, and the one dangerous item
// in it goes with the rest. So:
//
//   - CURATED ONLY. A captured chat exchange is a record of a moment, not a
//     standing claim; only hand-written memories assert current truth.
//   - NEVER AN OUTSIDE HOST. A proposed endpoint must be loopback or a private
//     LAN address. The nightly sweep must not be able to acquire the habit of
//     touching a third party because someone once pasted a URL.
//   - NEVER AN EPHEMERAL PATH. /tmp and /var are absent by design tomorrow;
//     proposing them manufactures UNPROVABLE verdicts out of nothing.
//   - NOT INSIDE A CODE FENCE. A fenced block is quoted material, not a claim
//     the memory is making.
//   - THE EXPECTED VALUE MUST BE IN THE PROSE. A ship tag is only proposed
//     when its sha sits on the same line: that pairing IS the claim, and the
//     3b calibration proved it needs the `^{}` peel to be checkable at all.
//     A bare tag mention is narrative ("v82 not yet TAGGED") and is skipped —
//     the naive rule confidently proposed `probe_expected: true` for a tag the
//     sentence said did not exist.
//
// The gap analysis put the population at "27 files". That figure has no
// derivation recorded anywhere in the research doc, this extractor's stated
// rules find a different number, and — following the Phase 1 ruling on the
// unreproducible "37 genuine queries" — the rules stand and the discrepancy is
// reported rather than tuned away.

// Ship tags as this project actually mints them (`git tag -a macwin-v112`).
// The leading boundary is explicit: `mcp-windows-v77` is a CI WORKFLOW, not a
// ship tag, and \b would have happily matched inside it.
const TAG_RE = /(^|[\s`([{|,])((?:macwin|universal|windows|mac)-v\d+)\b/g;
// A sha as this corpus writes them. All-digits is a CI run id, not a sha.
const SHA_RE = /(?:^|[\s`([{|,*])([0-9a-f]{7,40})\b/g;
const URL_RE = /\bhttps?:\/\/[A-Za-z0-9.:_-]+(?::\d+)?(?:\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]*)?/g;
const BACKTICK_RE = /`([^`]+)`/g;
// At least one directory component: `/bom-recommender.html` is a URL PATH
// someone quoted, not a file on this disk, and the naive one-segment rule
// proposed exactly that.
const FILEPATH_RE = /^\/(?:[^\s`]+\/)+[^\s`/]+\.[A-Za-z0-9]{1,6}$/;
// Loopback, or the RFC1918 space a private network lives in.
const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
const EPHEMERAL_RE = /^\/(?:tmp|var|private\/tmp|private\/var|dev|proc)\//;

const MAX_PER_DOC = 3;
const clip = (s, n = 180) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

// ── The adjudications, as a FILTER rather than a document ──────────────────
//
// test/probe-proposal-adjudications.md has recorded "do not propose file_exists for
// paths under /share/" since Round 2. Round 3 proposed two of them anyway. The rules
// were advice to a human reader and nothing enforced them, so every round
// re-adjudicated the same rejects by hand.
//
// ONLY ALREADY-ADJUDICATED RULES BELONG HERE. This is enforcement, not judgment: each
// entry corresponds to a written ruling, and a NEW class of reject gets adjudicated by
// a person first and encoded second.
//
// Vetoes are returned and printed, never dropped silently — a filter that hides its
// work is the same defect facing the other way.
const UNREACHABLE_ROOTS = ['/share/', '/Volumes/'];
// 🟥 THE DESIGN-CONSTANT-PORT RULE IS NOT ENCODED, AND THAT IS A RESULT, NOT AN
// OVERSIGHT. An earlier round rejected `http_status` against two recorded design
// CONSTANTS — a documented port and an admin UI address — reasoning that a liveness
// probe against a constant reads STALE whenever the app is merely closed. Encoding that
// veto would have vetoed TWO PROBES THAT ARE LIVE AND CURRENTLY FRESH, both
// `http_status` against a documented localhost port. The must-KEEP control caught it
// (test/probe-veto-preregistration.md), which is the control doing exactly its job.
//
// A later cross-account review then found the ruling's own premise to be FALSE: a closed
// port does not produce STALE. `http_status` against a port with nothing listening
// returns UNKNOWN ("never STALE on error"), so the hazard as written cannot occur. What
// actually happens is FRESH<->UNKNOWN flapping with whatever happens to be running —
// noise, not a lie, and a weaker argument than the one recorded.
//
// The live probes are still questionable for a DIFFERENT reason, the R5 one: neither
// memory claims its service is up, so a 200 verifies nothing either memory asserts. The
// durable fix is to re-point them at the port's DECLARATION rather than the service, at
// which point no veto rule is needed. That is a change to live probes, and live probes
// enter and leave only by human decision ("production probes enter ONLY via dream
// proposals a human confirms") — so until someone rules, this stays hand-adjudicated and
// the disagreement stays written down rather than resolved by weakening either side.

export function adjudicatedVeto(p) {
  const probe = String(p && p.probe || '');
  const evidence = String(p && p.evidence || '');
  const [kind, ...rest] = probe.trim().split(/\s+/);
  const arg = rest.join(' ');

  if (probe.includes('<repo>')) {
    return 'unresolved <repo> placeholder — resolve it or drop the proposal (Round 2)';
  }
  if (kind === 'file_exists') {
    const bad = UNREACHABLE_ROOTS.find((r) => arg.startsWith(r));
    if (bad) return `path under ${bad} is not on this machine — the failure mode is a false STALE (Round 2)`;
  }
  if (kind === 'http_status') {
    // A URL sitting after "Origin:" in the evidence is a header VALUE, not a service.
    if (/origin\s*:/i.test(evidence)) {
      return 'URL appears after "Origin:" — that is a header value, not a service (Round 2)';
    }
  }
  // RELEVANCE (2026-08-31). The question every probe must answer: WOULD THIS GO STALE IF
  // THE MEMORY'S CLAIM BECAME FALSE? An existence check on a bare identifier does not.
  // `grep_count config.js :: DEFAULT_HANDOFF_DIRS` expecting >=1 stayed FRESH through the
  // commit that emptied that very constant — it asserts that a NAME is present, which
  // survives any change to what the name holds. The same shape as the two live
  // http_status probes a cross-account review flagged for "testing something the memory
  // never claimed" (R5): the rule existed in prose and nothing enforced it.
  // Narrow on purpose: only a BARE identifier is vetoed. A literal carrying a value,
  // punctuation or a path (`"hybridRecall": false`, `app.get('/api/bom-source-view'`,
  // `/method/record-start`) is asserting something and passes untouched.
  if (kind === 'grep_count' && /^\s*(>=\s*1|>\s*0)\s*$/.test(String(p && p.probe_expected || ''))) {
    const literal = arg.split(/\s+::\s+/)[1];
    if (literal && /^[A-Za-z_][A-Za-z0-9_]*$/.test(literal.trim())) {
      return `existence check on the bare identifier '${literal.trim()}' — it stays FRESH ` +
             'however that identifier changes. Assert the VALUE the memory claims (2026-08-31)';
    }
  }
  return null;
}

/**
 * Draft probes for ONE document. Returns [] for a document that already
 * carries a probe — the author has spoken, and a proposal would be noise.
 */
export function proposalsForDoc(doc, { repoCandidates = [] } = {}) {
  if (!doc || doc.probe) return [];
  const body = String(doc.body || '');
  if (!body) return [];
  const out = [];
  const seen = new Set();
  const repo = repoCandidates[0] || '<repo>';
  const vetoed = [];
  const add = (p) => {
    if (out.length >= MAX_PER_DOC) return;
    const key = `${p.probe}|${p.probe_expected}`;
    if (seen.has(key)) return;
    // Every drafting path funnels through here, so no route can bypass the rulings.
    const veto = adjudicatedVeto(p);
    if (veto) { seen.add(key); vetoed.push({ ...p, veto }); return; }
    seen.add(key);
    out.push(p);
  };

  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;                        // quoted material, not a claim
    if (!line.trim() || /^\s*>/.test(line)) continue;
    if (out.length >= MAX_PER_DOC) break;

    // ---- a ship tag beside its sha. The pairing IS the claim, and it is the
    // shape the calibration scored twice (cal01, cal03).
    const tags = [...line.matchAll(TAG_RE)].map((m) => m[2]);
    if (tags.length === 1) {
      const shas = [...line.matchAll(SHA_RE)].map((m) => m[1]).filter((s) => !/^\d+$/.test(s));
      if (shas.length === 1) {
        add({ predicate: 'git_rev_parse', level: 'cheap',
          probe: `git_rev_parse ${repo} :: ${tags[0]}^{}`,
          probe_expected: `~${shas[0]}`,
          why: `the line pairs ship tag ${tags[0]} with sha ${shas[0]} — the claim stops being true the moment the tag is re-pointed`,
          note: 'the ^{} peel is REQUIRED: an annotated tag resolves to the tag object, not the commit',
          evidence: clip(line), repoCandidates });
      }
    }

    // ---- a LOCAL endpoint the memory treats as reachable.
    for (const m of line.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:)\]]+$/, '');
      let host;
      try { host = new URL(url).hostname; } catch (_) { continue; }
      if (!LOCAL_HOST_RE.test(host)) continue;   // never a third party, ever
      add({ predicate: 'http_status', level: 'all',
        probe: `http_status ${url}`,
        probe_expected: '200',
        why: 'the memory names a local endpoint as reachable; a status code is the cheapest proof it still is',
        hazard: 'LIVENESS, NOT DESIGN — confirm this only if the memory claims the service IS UP. If it ' +
          'records the port or route as a design constant, a liveness probe answers a question the memory ' +
          'never asked, and will read STALE every time the app is simply closed (calibration case cal18).',
        evidence: clip(line) });
    }

    // ---- an absolute path the memory points at as though it is there.
    for (const m of line.matchAll(BACKTICK_RE)) {
      const inner = m[1].trim();
      if (!FILEPATH_RE.test(inner) || EPHEMERAL_RE.test(inner)) continue;
      if (/[<>*?]/.test(inner)) continue;        // a placeholder, not a path
      add({ predicate: 'file_exists', level: 'cheap',
        probe: `file_exists ${inner}`,
        probe_expected: 'true',
        why: 'the memory points at a specific file as though it is there; a move or a rename falsifies it silently',
        evidence: clip(line) });
    }
  }
  Object.defineProperty(out, 'vetoed', { value: vetoed, enumerable: false });
  return out;
}

/**
 * Sweep a corpus for proposals. Pure: reads the docs it is handed, runs no
 * command, writes no file, returns one entry per document that has any.
 */
export function proposeProbes(docs, opts = {}) {
  const items = [];
  const vetoed = [];
  for (const d of docs || []) {
    if (d.parentName) continue;                  // sections inherit the parent's claim
    const proposals = proposalsForDoc(d, opts);
    for (const v of proposals.vetoed || []) vetoed.push({ name: d.name, ...v });
    if (proposals.length) items.push({ name: d.name, file: d.file, proposals });
  }
  // Non-enumerable so `items` still behaves as the plain array every caller expects,
  // while dream can report what was suppressed instead of hiding it.
  Object.defineProperty(items, 'vetoed', { value: vetoed, enumerable: false });
  return items;
}

/** Render one proposal as the frontmatter a human would paste. */
export function renderProposal(p) {
  return `  probe: ${p.probe}\n  probe_expected: ${p.probe_expected}`;
}
