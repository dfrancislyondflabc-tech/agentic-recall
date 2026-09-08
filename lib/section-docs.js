// lib/section-docs.js — PHASE B: a section is a document.
//
// THE PROBLEM, MEASURED. `project-changelog` is 635 KB of ~40 version
// entries; `release-build-checklist` is 100 KB across 21 sections. Retrieval returns
// the whole thing or nothing, and the useful unit is always ONE section: "the
// Gate #24 section", "the v112 entry". Worse, `RETRIEVAL.longDoc` deliberately
// penalises a document by its chunk count -- the correct fix for a 517-chunk
// document winning on the MAXIMUM over its chunks -- which means the checklist
// cannot win a query about its own content. Measured before this file existed:
//
//   search("release completeness receipt") -> a deck memory, a retrieval memory,
//   browser-agent..., release-v110-shipped, browser-agent-api...   (the checklist: absent)
//
// Penalise the document, promote the SECTION. Those are complementary, not
// contradictory, but they have to be calibrated together, which is why this is
// behind a flag and gated on measurement.
//
// 🟥 WHY A FLAG. Adding children changes the corpus POPULATION, and per-corpus
// statistics here are load-bearing: `loadScope` derives `referenceChunks` from
// the corpus, and blending populations has cost recall twice by measurement
// (staging into curated: MRR 0.826 -> 0.681). Splitting every eligible curated
// document takes that corpus from 148 docs to 413 (+179%). That is not a change
// anyone should ship on the strength of it sounding right.
//
// SCOPE. Only documents that are BOTH large AND genuinely sectioned. A 104 KB
// document with zero `##` headings (example-bot) gains nothing from being
// "split" into one child that is itself, and an exchange's headings are whatever
// someone happened to type in a chat reply, not a structure.

import { createHash } from 'node:crypto';

const MIN_BYTES = Number(process.env.MEMORY_SECTION_MIN_BYTES || 20000);
const MIN_SECTIONS = Number(process.env.MEMORY_SECTION_MIN_COUNT || 3);
const MIN_SECTION_BYTES = 200;
// How much of a section's opening prose joins its description.
//
// 🟥 THIS DOES NOT IMPROVE RETRIEVAL, and it was added believing it would.
// Five of twelve pre-registered questions miss on WRONG DOCUMENT, and the theory
// was that a child had nothing to match on but a few ordinary heading words
// ("AFTER GREEN", "What NOT to do"). Swept on the real index path:
//
//   prose chars   sections   recall   MRR
//   0 (control)     7/12       9/10   0.800
//   120             7/12       9/10   0.800
//   200             7/12       9/10   0.800
//   300             6/12       9/10   0.800
//
// Identical up to 200 and WORSE beyond -- `description` is the 2.0-weighted
// field, so lengthening it dilutes the heading through BM25 length
// normalisation. 120 is kept purely because the description is what a caller
// READS in a result list, and "release-build-checklist — AFTER GREEN — record + tag
// — Tag both platforms at the ship SHA…" tells them more than the heading alone.
// No retrieval claim is made for it.
const DESC_PROSE_CHARS = Number(process.env.MEMORY_SECTION_DESC_CHARS ?? 0);

// ON by default since the 2026-08-25 sweep. `0` disables.
//
// Shipped only once the measurement said so, on questions registered BEFORE any
// of them was run (test/section-questions.json): 12 asks whose answer lives in
// one section of a large document.
//
//   arm    sections   recall   MRR     artefact-squat
//   off      0/12       9/10   0.783        0/32
//   on       9/12      10/10   0.767        0/32
//
// Baseline 0/12 understates it: only 4 of the 12 returned even the PARENT, so
// eight ordinary questions about the build checklist and the diagnostic guides
// retrieved nothing useful at all. Recall goes UP, because a 654 KB changelog
// and a 100 KB checklist stop distorting the corpus statistics that the absence
// guard reads. The changelog now appears on 4 of 32 probes, every one a real
// keyword match (kw 0.25-0.82) -- NOT the kw=0 max-over-chunks artefact, which
// stays at zero.
//
// 🟥 What made it work was NOT the long-document penalty this was meant to need.
// beta and the child waiver barely move the result across the whole grid. The
// binding constraint was IDF counting index ROWS -- see the docFile note in
// lib/bm25.js -- and the build crash was children inheriting their parent's
// hash into a reuse map keyed by file. Neither was the thing I predicted.
export const sectionDocsEnabled = () =>
  process.env.MEMORY_SECTION_DOCS !== '0' && process.env.MEMORY_SECTION_DOCS !== 'false';

export function slugifyHeading(h) {
  return String(h).replace(/^#+\s*/, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

/**
 * Split one body at `##` boundaries. Fenced code blocks are skipped, because a
 * `## heading` inside a shell snippet is not a section -- the same trap _headingsOf
 * had to be taught in tools/memory.js.
 */
export function splitSections(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let fence = false, cur = null, offset = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (m && !/^###/.test(line)) {
      if (cur) { cur.end = offset; out.push(cur); }
      cur = { heading: m[1].trim(), start: offset, lines: [line] };
    } else if (cur) cur.lines.push(line);
    offset += line.length + 1;
  }
  if (cur) { cur.end = offset; out.push(cur); }
  return out.map((s) => ({ heading: s.heading, start: s.start, end: s.end, text: s.lines.join('\n') }))
    .filter((s) => s.text.length >= MIN_SECTION_BYTES);
}

export function eligible(doc) {
  const body = doc.body || '';
  if (body.length < MIN_BYTES) return false;
  // 🟥 NEVER SPLIT THE INDEX. MEMORY.md is the corpus's table of contents -- a
  // compact list of pointers whose whole value is being read as ONE unit, and
  // which is loaded into context every session. It crossed the 20 KB threshold
  // at 21,000 bytes and was silently cut into 13 fragments, each a list of links
  // with no context, which also broke the "a colliding basename does not shadow
  // the curated one" invariant. An index is the one document whose parts mean
  // nothing apart.
  if (/^MEMORY\.md$/i.test(String(doc.file || '').split(/[\\/]/).pop() || '')) return false;
  // An exchange is auto-captured conversation. Its `##` lines are whatever was
  // typed in a reply, so they do not describe a structure worth indexing.
  if (doc.type === 'exchange') return false;
  return splitSections(body).length >= MIN_SECTIONS;
}

/**
 * Given the loaded docs, return {docs, added} with section children appended and
 * eligible parents reduced to a NAVIGATION STUB (description + heading list).
 *
 * The parent must not keep its full body: leaving it would index every byte
 * twice and let a parent and its own child both answer as if they were
 * independent evidence. The stub keeps "what is the zip checklist" working.
 *
 * Children inherit the parent's `file`, which is what makes capPerDocument
 * (lib/search.js) cap a parent and its children TOGETHER -- it counts slots by
 * `r.file`. No second cap mechanism, exactly as the plan asked.
 */
// ---- B2: A SUPERSEDED VERSION SECTION LOSES ITS BOOST ----------------------
//
// The changelog is 135 sections at hot tier, of which the newest two or three
// matter operationally. Every query about a feature competes against forty
// versions of prose about that feature.
//
// 🟥 BY VERSION ORDER, NEVER BY LANGUAGE. v19..v109 are superseded by v112
// because of their POSITION IN A SEQUENCE, which is arithmetic. Asking anything
// to read a section and judge whether it is stale is the vocabulary trap that
// has failed three times in this repo. A section with no version in its heading
// is left alone -- unorderable is not the same as old.
//
// Demotion is to ARCHIVE, not deletion: the section stays searchable and
// `neighbors` still reaches it, it simply stops being boosted.
const KEEP_NEWEST_VERSIONS = Number(process.env.MEMORY_SECTION_KEEP_VERSIONS ?? 3);

export function versionOf(heading) {
  // FIRST v-number wins: "v22 / Windows v13" is Mac v22, and the Windows number
  // is a different sequence that must not be compared against it.
  const m = /\bv(\d{1,4})\b/i.exec(String(heading || ''));
  return m ? Number(m[1]) : null;
}

// A section the AUTHOR marked stale. Literal marker only -- never inferred.
const STALE_MARKER = /⚠️\s*STALE|STALE,\s*do not trust/i;

function assignSectionTiers(kids) {
  const versioned = kids.filter((k) => versionOf(k.heading) !== null)
    .sort((a, b) => versionOf(b.heading) - versionOf(a.heading));
  const keep = new Set(versioned.slice(0, KEEP_NEWEST_VERSIONS).map((k) => k.name));
  for (const k of kids) {
    if (STALE_MARKER.test(k.heading)) { k.tier = 'archive'; continue; }
    if (versionOf(k.heading) === null) continue;      // unorderable -> untouched
    if (!keep.has(k.name)) k.tier = 'archive';
  }
  return kids;
}


export function withSectionDocs(docs, { synthDescription } = {}) {
  // PASSED IN, NOT IMPORTED. lib/corpus.js already imports this module, so
  // importing synthDescription back out of it would close a cycle for one
  // helper. The fallback keeps this function usable on its own (tests call it
  // directly with hand-built docs).
  const synth = synthDescription || ((t) => String(t || '').split('\n').slice(0, 4).join(' ').slice(0, 200));
  const out = [];
  let added = 0, split = 0;
  for (const d of docs) {
    if (!eligible(d)) { out.push(d); continue; }
    const secs = splitSections(d.body);
    split++;
    // 🟥 SLUGS ARE NOT UNIQUE ON THEIR OWN. A document can repeat a heading --
    // "the little traps", "v109 — the small things" -- and two children with the
    // same name collide in every name-keyed structure: get(), backlinks, and the
    // incremental-reuse map. Disambiguate by ordinal.
    const usedSlugs = new Map();
    const mine = [];
    for (const s of secs) {
      added++;
      mine.push({
        ...d,
        name: (() => {
          const base = slugifyHeading(s.heading);
          const n = (usedSlugs.get(base) || 0) + 1;
          usedSlugs.set(base, n);
          return `${d.name}#${base}${n > 1 ? '-' + n : ''}`;
        })(),
        // 🟥 KEEP THE PARENT'S `type`. Overwriting it with 'memory-section'
        // erased `handoff-doc`, and the handoff index asserts that every
        // document in it IS one -- 46 children silently broke that invariant.
        // `type` describes WHERE a document comes from and carries its
        // read-only semantics; being a section is orthogonal, so it gets its
        // own field. `parentName` already identifies a child for ranking.
        isSection: true,
        // ITS OWN HEADING, NOT ALL 275 OF ITS PARENT'S. lib/bm25.js indexes
        // `headings` as a separately weighted field, so inheriting the parent's
        // full list gave every child a claim on every heading in the document --
        // 138 changelog children each asserting all 138 version titles.
        headings: [s.heading],
        parentName: d.name,
        heading: s.heading,
        headingPath: [d.name, s.heading],
        charRange: [s.start, s.end],
        // THE HEADING ALONE IS NOT ENOUGH TO FIND A SECTION BY.
        //
        // `description` is the 2.0-weighted field, and a child's was just
        // "<parent> — <heading>". For a section titled "AFTER GREEN — record +
        // tag" or "What NOT to do" that is a handful of ordinary words, so the
        // section lost to any standalone memory that happened to share them:
        // five of twelve pre-registered questions missed on WRONG DOCUMENT, not
        // wrong section. Synthesise from the section's own opening prose, using
        // the same helper a frontmatter-less document already gets.
        description: DESC_PROSE_CHARS > 0
          ? `${d.name} — ${s.heading} — ${synth(s.text).replace(/^.*? — /, '').slice(0, DESC_PROSE_CHARS)}`
          : `${d.name} — ${s.heading}`,
        descriptionSynthesised: true,
        body: s.text,
        // ITS OWN IDENTITY, NOT ITS PARENT'S. Spreading the parent handed every
        // child the parent's hash and size, so the incremental-reuse path in
        // index-store treated each one as the unchanged 635 KB parent and gave
        // it the parent's whole chunk set. Hash the child's OWN text.
        hash: createHash('sha256').update(`${d.name}#${s.heading}\n${s.text}`).digest('hex'),
        size: s.text.length,
        links: [],
        backlinks: []
      });
    }
    // THE STUB DOES NOT REPRODUCE THE HEADINGS.
    //
    // An earlier version pasted every heading into the stub body, which for the
    // changelog was 18 KB of feature words -- and made the stub a keyword magnet
    // that answered "what ports are used across all these projects". It was also
    // redundant three times over: lib/bm25.js already indexes `doc.headings` as
    // its own weighted field, and every heading is the first line of its own
    // child document. Queries ABOUT the document match its name and description;
    // queries about its CONTENT should match the section that holds it.
    assignSectionTiers(mine);
    out.push(...mine);
    out.push({
      ...d,
      body: `${d.description || d.name}\n\n(${secs.length} sections, indexed individually.)`,
      // The stub keeps only the document's own title. Every `##` heading now
      // belongs to the child that owns it, so repeating them here would restore
      // the magnet by another route.
      headings: (d.headings || []).filter((h) => !secs.some((s) => h.includes(s.heading))).slice(0, 4),
      isSectionParent: true,
      sectionCount: secs.length
    });
  }
  return { docs: out, added, split };
}
