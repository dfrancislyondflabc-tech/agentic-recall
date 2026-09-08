# Contributing

## The one rule that matters here

**A measurement that cannot fail is not a measurement.**

This project's retrieval behaviour is calibrated, not guessed. Several constants — the absence
floors, the long-document correction, the phrase guard — came from labelled measurements, and the
record of each, *including the attempts that were rejected and the number that killed them*, is
written down.

> **A note on `test/…` paths in this file and in the README.** They are **citations to the
> author's tree, not files in this distribution.** The suite and its fixtures are not shipped —
> they assert against one particular private corpus (see *Running things*). They are named so a
> claim can be traced to where it was measured, and so you can ask for one; they are not
> instructions to open a file. Sorry for the tease.

If you change retrieval, bring numbers. A pull request that says "this feels better" cannot be
evaluated. A pull request that says "on these 40 labelled questions, false refusals went 8 → 6 and
false answers stayed at 0" can.

### And choose your test questions adversarially

The single most expensive mistake made in this codebase was a labelled set that was too easy. A
feature was built, measured against 40 "absent" questions made of invented proper nouns, shown to
cost nothing, shipped — and reverted the same day, because invented proper nouns are caught by a
*different* code path, so the set could not detect the failure at all. Against realistic questions
the same feature turned 1 wrong answer into 11.

If you are testing whether the system correctly says "I don't know", your questions must be about
**real topics in ordinary words that the corpus genuinely does not cover**. See
`test/fixtures/ordinary-word-absences.json`. This has now caught three separate attempts.

## Running things

```bash
npm install
npm test                      # self-contained stdio smoke test; needs no memories
```

The full suite is not public. It asserts against one particular corpus — it would fail for you,
and it is where the author's own data lives. `npm test` here runs `scripts/verify-stdio.js`, which
builds its own fixtures and passes on any machine. A synthetic fixture corpus that would let the
whole suite ship is a genuinely useful contribution and nobody has done it.

## Before you open a PR

- `npm test` exits 0.
- `node scripts/check-release-clean.mjs` exits 0. It refuses any tree that names a person, a
  customer, a vendor, an internal host or a credential. It is deliberately strict, it carries its
  vocabulary as hashes so this repo never spells the terms it detects, and it fails **closed** — an
  unreadable policy refuses everything rather than waving the tree through.
- Comments explain **why**, not what. The code is dense with hard-won reasons; a comment that
  restates the line below it is worse than no comment.

## Scope

Bug reports and measured retrieval improvements are very welcome. So are portability fixes —
Windows in particular is under-tested. Feature requests that add a new storage backend or a
network service are probably a different project: this one is deliberately a local, file-backed,
single-user tool.
