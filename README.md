# agentic-recall

**Long-term memory for agentic tasks. It tells you when it doesn't know.**

An MCP server that gives Claude Desktop and Claude Code a persistent memory across
sessions — and, unlike a plain vector store, an explicit answer when the corpus does
not contain what you asked for.

![agentic-recall: a query that hits, and a query that does not](docs/demo.gif)

```jsonc
// ~/.claude.json  (Claude Code)  or  claude_desktop_config.json  (Claude Desktop)
"mcpServers": {
  "memory": {
    "command": "node",
    "args": ["/absolute/path/to/agentic-recall/index.js"],
    "env": { "MEMORY_DIR": "/absolute/path/to/your/memory/folder" }
  }
}
```

```bash
git clone https://github.com/dfrancislyondflabc-tech/agentic-recall.git
cd agentic-recall && npm install && npm test    # 89+ checks, no corpus of your own needed
```

Requires **Node 20 or 22**. Nothing else — the embedding model downloads on first index
and then runs locally. Your memories never leave the machine.

Built by Daniel Francis-Lyon — questions, bug reports and criticism all welcome, either as an
issue on this repo or at **danfrancislyon@gmail.com**.

## The part most memory tools skip

Retrieval always returns *something*. Ranked by similarity, the least-bad match comes back
looking like an answer, and an agent acting on it cannot tell the difference between "here is
what you wrote" and "here is the closest thing to it".

This server separates those two cases and says which one you got:

```jsonc
// asked about something that isn't in the corpus
{ "results": [],
  "confidence": "low",
  "bestWeak": [{ "name": "wheel-truing", "score": 0.31 }],
  "absenceNote": "no strong match — 'afternoon' appears nowhere in this corpus" }
```

Nothing was invented, nothing was silently ranked into first place, and the nearest thing is
offered as a candidate rather than as an answer. Everything below is about how that verdict is
reached and how it is measured.

---

Two-tier hybrid retrieval over Claude's persistent memory corpus, exposed to
Claude Desktop and Claude Code as a single MCP tool: **`memory`**.

The curated corpus is the folder you point `MEMORY_DIR` at (see **Environment overrides**).
`MEMORY.md`, if you have one, is treated as a hand-curated tier-1 index.

Figures quoted throughout this README — "121 `.md` files, ~2.7 MB", timings, hit rates — are
measurements of **the author's own corpus**, not properties of yours. They are here because a
claim with a number behind it can be checked; treat them as the conditions a result was obtained
under, not as promises about your data.
Three more work corpora sit beside it, each with its **own** index and its own
statistics: **other projects'** memory folders (`projects`), auto-ingested
conversation exchanges (`staging`) and the institutional handoff documents
(`handoff`, read-only) — plus the **library**: imported reference material
(books, manuals, policies) in per-category corpora that are searched **only
when named** (`scope:'books'`, or `scope:'everything'`) and can never touch a
work score. See *Four work corpora + the library, one index each*.

---

## Why it exists

Reading the whole memory folder into context costs ~2.7 MB and buries the
relevant three lines. This server answers the question *"which memories matter
for what I'm doing right now?"* with three retrievers whose failure modes cancel:

| retriever | field | good at | blind to |
|---|---|---|---|
| **BM25F** | title + description + headings + **body**, each length-normalised separately | slugs, part numbers, file names, jargon, any literal string in the text | paraphrase |
| **dense cosine** | ~200-word body chunks + a per-doc summary vector | "how do I restart the email app server" → a memory that never says *restart* | exact identifiers |
| **phrase proximity** | the tightest window of body tokens covering the query's terms | telling a quoted sentence apart from a document with the same vocabulary | anything not stated literally |

Scores are normalised, fused 42/42/16, then adjusted by a **long-document
correction**, the **hot-tier boost** and a **mild recency decay**. Every result
reports its `provenance` (`keyword` / `semantic` / `phrase` / `both`) so a
surprising rank is diagnosable rather than mysterious — and when nothing
matched well enough, `search` says so instead of guessing (see below).

### v1.1 — the three defects the 2026-08-14 benchmark measured

`retrieval-features-baselines/memory-systems-benchmark.md` scored this server
against a pre-loaded `MEMORY.md` over 32 probes and found three real defects.
All three are fixed; the numbers are in that file's v1.1 section.

1. **BM25 was blind to bodies.** It indexed title + description + headings only,
   so a distinctive phrase living in a body paragraph had to be recovered by the
   dense leg — structurally the wrong tool for a literal string. The body is now
   a fourth BM25F field (its own length normalisation, weight 0.3), and a
   **phrase-proximity leg** reads the body directly. Verbatim recall went from
   4/6 found and 1/6 sentence-located to **6/6 and 6/6**, every one at rank 1.
   Snippets are now cut around the matching window rather than the top of the
   document, so a quote search returns the sentence you quoted.
2. **It could not say "nothing".** `search` always returned `limit` results; on
   the four absent probes it handed back confident-looking wrong documents, one
   at 0.75 — higher than 20 of the 28 correct answers. It now returns
   `noStrongMatch: true` with the candidates moved to `bestWeak`, on **4/4**
   absent probes with **0/28** false absences. There is no clean score
   threshold — the distributions overlap across their whole middle — so the
   verdict is a conjunction of measured weaknesses plus a vocabulary test.
   the derivation and its margins are recorded in the author's `test/` tree.

   > 🟥 **The absence verdict gets less reliable as your corpus gets smaller, and a new corpus is
   > small.** `orphanShare` asks what fraction of your question's distinctive words appear nowhere
   > in the corpus — so on a thin vocabulary, ordinary synonyms are genuinely absent and a question
   > the corpus CAN answer gets refused. Measured here on 122 files: 5 of 20 answerable questions
   > called absent. Measured by an independent reviewer on **13** files: **3 of 4**. It fails safe —
   > the right document is in `bestWeak`, not invented — but on a young corpus read `bestWeak`
   > before believing a refusal, and expect this to improve as you write more. **`test/…` paths in
   this README are citations to where a number was measured, not files in this distribution** —
   the suite is not shipped, because it asserts against one private corpus. See CONTRIBUTING.
3. **One enormous document was winning everything.** A 616 KB changelog took a
   top-3 slot on **21 of 32** test questions — questions about deployment, about
   pricing, about a bug in a scraper. It had no business in most of them.

   The cause is in how a document is scored. Documents are split into chunks,
   and a document's score is the score of its *best* chunk. That changelog
   splits into **517** chunks; the typical memory in the corpus splits into
   **4**. So the long document gets 517 chances to have one paragraph that
   happens to sit near your question, and the short one gets 4. Ask about
   anything and something in 616 KB of release notes is vaguely on topic.

   It's the same effect as a library where one book runs to 3,000 pages and
   everything else is a five-page note. Ask any question and the huge book
   contains *a* page that looks relevant — not because it is the best answer,
   but because it had the most chances to match.

   The giveaway was `keywordScore: 0` on almost every one of those 21 hits:
   **none of the words in the question appeared in the document at all.** It
   was winning purely on one chunk out of 517 landing near the question in
   embedding space.

   The fix is to shrink the semantic score of documents that are far longer
   than that corpus's own normal length. "Normal" is measured per corpus rather
   than hard-coded, since a corpus of books and a corpus of notes disagree about
   what long means. And the shrink is *waived in proportion to keyword
   evidence*: if your words really are in the document, the penalty lifts. Long
   is only suspicious when the document didn't match what you actually asked.

   Result: top-3 appearances **21 → 0**. It is de-prioritised, not hidden —
   ask for that changelog by name and it still comes back at rank 1 with
   `keywordScore: 1.0`, because now the words match.

### The keyword score is on an absolute scale

Fusing two retrievers only works if both scores mean the same thing on every
query. A per-query-max normalisation does not: it hands 1.0 to whatever scored
best, so on a paraphrase where nothing really matched, an accidental match still
carried half the fused score. (A question about which zip packages to maintain
returned `monday-quote-create-download` at #1 on the token *download* alone.)

So the keyword leg is scored against measured reference points instead — a raw
noise floor, the score a genuine lexical match earns, and the share of the
query the document actually answered — each capped by what the query can
possibly achieve, so a short exact query like `MEMORY` is not punished for
having little to match. `npm run measure-keyword-scale` re-runs the measurement
those constants came from (four query populations: title-literal,
description-literal, in-domain paraphrase, out-of-domain) and prints where the
shipping constants sit against it. The derivation lives next to the numbers in
`lib/config.js`.

The fused path only. In `bm25-only` mode there is no second score to be
comparable with, so the per-query-max form is kept and degraded-mode ranking is
unchanged.

---

## Install

**Did you get this as a zip?** Then none of this section applies: open `START-HERE.txt` and
double-click `SETUP-WINDOWS.cmd` or `SETUP-MACOS.command`. A zip carries its dependencies and its
search model already — there is nothing to clone and nothing to `npm install`. (Up to 1.7.1 the
zips also shipped a `dist/` install guide that said the opposite; it is gone.)

From source:

```bash
git clone https://github.com/dfrancislyondflabc-tech/recall-mcp.git
cd recall-mcp
npm install
```

Node 20 or 22. There is nothing to build and no global install — the server runs from this directory.

> **Not the `recall-mcp` on npm.** That name belongs to a different project (a different self-hosted
> memory server). This one is not published to npm; clone it.

**Then tell it where your memories are.** It does **not** search your disk for them — there is no
sensible default, so it does not guess. `MEMORY_DIR` (or `memoryDir` in `local-config.json`, copied
from `local-config.example.json`; gitignored, never indexed) is the whole of the discovery logic.

**If you already use Claude Code's memory, you are done in one line.** Point it at that folder and
it indexes those files *in place* — nothing is copied, nothing is converted, and Claude carries on
writing them as it always did:

```bash
export MEMORY_DIR=~/.claude/projects/<project-slug>/memory
```

(The slug is your project's path with the separators replaced — `ls ~/.claude/projects` to find
yours.) Reading Claude's own directory, rather than a copy of it, is the reason this server's
corpus cannot silently drift out of date.

**If your history lives somewhere else, import it once.** A ChatGPT export `.zip`, a folder of
Obsidian/Notion markdown, or a single file:

```bash
node scripts/import-memories.js /absolute/path/to/export.zip --dry   # preview
node scripts/import-memories.js /absolute/path/to/export.zip
```

This one *does* write files into `MEMORY_DIR`, converting as it goes. `memory({action: "import"})`
is the same thing from inside a conversation.

**Remembering the conversations themselves is controlled by the connector toggle**, and there is
nothing else to configure. While the connector is on, the server spawns a capture walk every five
minutes by itself. The only thing a hook adds is the FINAL exchange of a chat you walk away from,
captured as it ends rather than on a later sweep — `node packaging/install-hooks.mjs` adds
`scripts/auto-ingest.js` on Stop and SessionEnd for this install (it backs up
`~/.claude/settings.json` first, touches no other hook, does nothing on a second run, and reverses
with `--uninstall`). After that the switch you already use in Claude's UI is the switch:
connector **on** means this server is running, which it advertises by leaving a dated mark on disk;
the hook reads that mark and captures the session. Connector **off**, no mark, nothing captured,
silently. Captured conversations land in a **separate** staging corpus at a lower tier, so they are
searchable but never outrank a memory you wrote deliberately.

Two overrides live in `local-config.json` — and it has to be that file rather than an environment
variable, because hooks are spawned without your shell environment:

```json
{
  "memoryDir": "/absolute/path/to/your/memories",
  "captureAlways": true
}
```

`captureAlways: true` remembers **every** session, connector on or off. `autoIngest: false`
remembers **none**, ever. Set one or neither — the default, with both absent, is "remember the
sessions you had the connector on for".

**And if you had it switched off and only realised afterwards that the work mattered**, nothing is
lost — the transcript was on disk the whole time, it simply was not ingested. Ask for it after the
fact:

```
memory({action: "capture", sinceMinutes: 60})   // remember the last hour
memory({action: "capture"})                     // remember this whole session
```

Already-captured exchanges are skipped, so running it twice is safe. It answers with two counts,
because on a live chat the common outcome is neither "new" nor "nothing": `exchangesCaptured` is
exchanges that were not in the store at all, and `exchangesRefreshed` is exchanges already there
whose text had GROWN — normally the turn you are in the middle of. `sinceMinutes` is measured
against each exchange's last activity, so a turn that has been running for an hour is still inside
`sinceMinutes: 30`.

A memory is just a markdown file with a `name:` and a `description:` in its frontmatter:

```markdown
---
name: freehub-service-log
description: Symptoms and fix for the loaner-wheel freehub pawls disengaging under load
---

The pawls stop engaging when the grease thickens, usually on a climb — the cranks turn and
the wheel does not. Strip and re-grease with a light oil, not the heavy grease in the tub.

Related: [[wheel-build-notes]]
```

`name` is how the memory is addressed (`get`, `[[wikilinks]]`); `description` is what a search
sees first, so it is worth writing as the sentence you would want back. Everything after the
frontmatter is the body. Nothing else is required — no `metadata:` block, no tier, no id. Then:

```bash
npm run index        # first build downloads the embedding model, then embeds: ~3 min
npm test             # self-contained: builds its own fixture corpus, needs none of yours
npm run verify       # the same check under its other name
```

`npm test` drives the real server over raw stdio JSON-RPC and exercises all thirteen actions
against a temporary corpus it writes itself, so it is meaningful on a machine with no memories at
all. The exit code is the verdict. (The author's full suite is not public — it asserts against one
particular corpus and would fail for you. See `CONTRIBUTING.md`.)

Measurement scripts, read-only and re-runnable — the tuning constants in `lib/config.js` each cite
the measurement they came from:

```bash
npm run measure-keyword-scale   # the absolute keyword scale
npm run analyse-queries         # what has been asked of it
```

---

## The tool

One gateway tool, thirteen actions: `search`, `get`, `neighbors`, `latest`, `thread`,
`verify`, `index`, `index_status`, `probe_status`, `promote`, `demote`, `import`, `capture`.
The four you will use daily are documented in full below.

### `memory({action: "search", query, limit?, scope?})`
Hybrid retrieval. Returns `name`, `description`, `tier`, `score`,
`keywordScore`, `semanticScore`, `phraseScore`, `provenance`, `snippet`,
`links`, `path`, `readOnly`, `corpus` (which of the four indexes answered), the
attribution block (`account`, `project`, `sessionId`, `sessionTitle`, `type`),
plus a top-level `mode`
(`hybrid` | `bm25-only` | `unavailable`) and, when degraded, a
`degradedReason`. Default `limit` 8.

**Every response says when its index was built** — see *Freshness* below:

| field | meaning |
|---|---|
| `indexBuiltAt` | ISO time the index these results came from was built |
| `indexBuiltAtByScope` | `scope: "all"` only — one build time per corpus |
| `indexStale` | the corpus has changed since, and the repair did not happen |
| `staleFiles` | how many files moved |
| `staleWarning` | one sentence saying so, with the files named and why it was not repaired |
| `indexReindexedInline` / `indexReindexSeconds` | the guard rebuilt it before answering |
| `indexBuiltInline` | that corpus had no index at all and was small enough to build before answering |
| `corpusNote` | for `projects` / `handoff`: what this corpus is and that it has its own statistics |
| `indexCheckedFiles` / `indexCheckMs` | the cost of the check itself (1–2 ms for 122 files) |
| `newestSourceModified` | the newest mtime in the corpus, live |
| `modifiedFieldNote` | states that a result's `modified` is index-time, not live |
| `serverVersion` / `serverStartedAt` | which build of this server answered, and when it started |

**A result's `modified` is the file's mtime AT INDEX TIME, not a live read.**
`memory({action: "get"})` returns a live stat, as `liveModified`. Reading one as
the other is what produced a confidently wrong conclusion about project state on
2026-08-19.

**Search always covers both tiers.** Archived memories are fully searchable;
they simply do not get the hot boost.

**A single document takes at most one top-N slot** (`RETRIEVAL.maxSlotsPerDoc`).

**When nothing matched, it says so.** Instead of ranking the least-bad
document, `search` can return:

```jsonc
{
  "noStrongMatch": true,
  "confidence": "low",
  "signals": { "topScore": 0.40, "topPhrase": 0.25,
               "lexicalCoverage": 0.24, "orphanShare": 0.46 },
  "absenceNote": "No strong match: the term(s) that make this question specific
                  appear NOWHERE in the corpus (kubernete — 46% of the query's
                  discriminative weight, floor 40%). …",
  "results": [],
  "bestWeak": [ /* the nearest documents, NOT answers */ ]
}
```

`results` is emptied and the candidates move to `bestWeak`, so a caller that
checks `results` cannot accidentally report a non-answer, while one that wants
to overrule the verdict still has the candidates. `signals` is always present on
the fused path, verdict or not, so a surprising call is diagnosable.

Two independent rules produce it (constants and margins:
measured, not guessed):
- **vocabulary** — the terms that make the question specific exist nowhere in
  the corpus (`orphanShare ≥ 0.40`) and nothing holds the remaining words
  together. Compound forms are forgiven: `de-duplication` is absent while
  `duplication` is present, and the corpus clearly knows the concept.
- **evidence** — every word is familiar, but nothing scored (`< 0.38`), nothing
  is phrased that way (`< 0.40`), and most of the question went unanswered
  (lexical coverage `< 0.20`). All three, because each alone fires on real
  questions.

The verdict is **advisory and calibrated on this corpus**. Never use it to prove
a negative that matters — on a held-out set of deliberately vocabulary-free
in-domain questions, 5 of 20 are called absent. `grep` proves a negative; a
score does not.

Never claimed in `bm25-only` mode: the constants are calibrated on the fused
three-leg score, so degraded mode reports `confidence: "unrated"` instead.

#### What a multi-corpus response is made of

`scope: "all"` (and an array scope) returns one ranked **section** per corpus under `groups`,
because the corpora do not share statistics and blending them measurably costs recall. Three rules
govern the shape of that envelope; all three came out of one real response, measured on
2026-09-07, which was 56,550 bytes for ten results and told its reader the opposite of the truth.

| | |
|---|---|
| `groups.<corpus>.resultsRef: "results"` + `count` | that section's rows are the top-level `results` entries carrying `corpus: "<corpus>"`, in that order. They are serialized **once** — the duplicate copy was 30 % of that response. Everything else in the section is its own. |
| `groups.<corpus>.empty: true` + `emptyNote` | that corpus holds **0 files and has no index**: nothing to rank and nothing to build. An empty corpus is not a stale one, contributes nothing to the top-level `indexStale`, and makes no claim about the others. A corpus that has files and no index is still **stale**, still says so, and still sets the top-level verdict — with a warning that names it (`[staging] …`) and says the rest of the response stands. |
| `bestWeak` capped to names and scores | in a response where **another** corpus answered, a section that ranked nothing keeps three nearest neighbours as `{name, score}` and drops its `absenceNote`; the top-level `guidance` names every section this happened to and gives the call that returns the whole verdict. When nothing hit **anywhere**, the fallback is the answer and both stay in full. |

`brief: true` on `search` or `latest` trims the **rows** — `name`, `corpus`, `score`, `snippet`,
`provenance` and the timestamp, nothing else. The envelope is untouched: `indexStale`,
`staleWarning`, `recencyVoid`, `recentUnindexed`, `uncapturedSessions`, `captureHealth`,
`configWarning` and `guidance` are all still there. A caller asking for fewer bytes has not asked
to be told less about what was never read.

Measured on the reporting caller's own query against the same corpora, read-only, before and
after: **56,634 → 26,842 bytes**, and **17,123 with `brief: true`**. The ten ranked rows are 12,426
bytes of that, in both runs — they are the answer, and they are what is left.

### `memory({action: "latest", query, limit?, scope?, sessionId?, account?, project?})`

**For state questions — "did X finish", "what happened after Y", "where did we leave X".**

`search` ranks by relevance, and relevance cannot separate *"we are starting X"* from *"X is
finished"*: both are equally about X. That is not a ranker that needs improving, it is the wrong
axis for the question. `latest` filters on **every** term (no ranking at all) and orders **newest
first**.

It exists because of a specific failure. A session was asked whether a re-parse had completed. It
searched, got the exchange where the work *started* at score 0.88, saw no completion ranked above
it, and reported the answer unknowable. The answer was in the corpus the whole time, one
term-filter away.

```
memory({action: "latest", query: "reparse"})
  -> orderedBy: "ts", totalMentions: 16, scopeHint: {scope: "staging", explicit: false}
     results[0]: x-fb357616-20260903T235959000Z   threadPosition: "650 of 650"   laterInThread: 0
```

**Fields worth reading**

| field | why |
|---|---|
| `orderedBy` | `ts` = when the words were said. `mtime` = file bookkeeping, **not** chronology. |
| `scopeHint` | which corpus answered, and whether that was your choice or the default. |
| `threadPosition` / `threadLast` | an exchange is one moment in a conversation. If `laterInThread > 0`, fetch `threadLast` before reporting what happened. |
| `unmatchableTerms` / `termWarning` | this is an AND-filter, so one unknown term takes it to zero — that zero is named, not silent. |
| `filterWarning` | fires when `account`/`project` names a label this corpus does not use at all (e.g. `project:"this"` against staging, where every doc is labelled `store`). |
| `indexStale` / `staleWarning` | `latest` is the action **most** damaged by staleness: new material is exactly what a stale index lacks. |

**Query it with identifiers, not prose.** This is a literal string filter. Measured over six
real questions with known answers:

| query | result |
|---|---|
| `"pushed commit with failing test semicolon"` | nothing — the corpus says `';'`, never "semicolon" |
| `"pushed c509e0f"` | the exact exchange, immediately |
| `"high RAM usage cause overnight run"` | a coincidental match on "overnight" in a JSON schema |
| `"max-old-space-size heap 20000 rows"` | the exact answer — 8 GB heap ceiling, `.all()` on 20,000 rows |

Same corpus, which held every answer the whole time. Commit SHAs, file names, flags, function
names, error strings and exact numbers work; prose belongs in `search`, which ranks. When the
strict filter finds nothing it relaxes to the best available match and sets `relaxed` +
`droppedTerms` — a dropped term is often the one that mattered.

**Compaction summaries are demoted, not dropped.** When a session runs out of context the harness
reopens it with a summary of everything so far, and that gets ingested as an exchange (34 of 2,318
here). It restates a whole conversation, so it matches almost any filter while carrying a recent
timestamp for old content — one took first place on 5 of 6 test questions, once purely because it
restated the *question*. Excluding them outright measured worse: it fixed one question and broke
another whose answer existed only inside a summary. So they are labelled `isCompactionSummary`,
sorted below first-hand exchanges, and removable with `includeSummaries: false`.

**`scope: "all"` returns one section per corpus, never a merged list.** The corpora do not share a
clock — staging documents carry `ts`, curated documents carry none — and merging them by time
compares incomparable things. Concretely: the 2026-08-19 account backfill rewrote all 118 curated
files in one pass, so in a merged list every one of them would outrank a genuine 08-22
conversation. Each section declares its own `orderedBy`.

**The limit no field can fix.** The corpus records what conversations *said*, never what happened
after the newest one. Measured: the newest exchange said *"nothing queued, v111 tagged"* — 13
commits landed after it. When the answer matters, check the world.

### `memory({action: "thread", name, forward?, back?})`

**Read forward from a hit, in sequence.** `threadLast` gives the *end* of a thread, which is the
wrong end of a long one: the resolution to a claim at exchange 200 of a 650-exchange thread is at
201–210. Relevance can't bridge that gap either — the exchange that *resolves* something often
shares almost no vocabulary with the one that raised it ("done", "shipped", "you were right").
Sequence can, and sequence is already in the `x-<session>-<ask timestamp>` names (e.g. `x-fb357616-20260903T054233800Z`, which sort as time), so this is arithmetic, not
retrieval.

```
memory({action: "thread", name: "x-fb357616-20260903T054233800Z", forward: 4, back: 1})
  ->  -1  x-fb357616-20260903T053810112Z
      ▶0  x-fb357616-20260903T054233800Z   <- the anchor
      +1  x-fb357616-20260903T060102450Z …          remainingAfter: 30, threadLast: x-fb357616-20260903T235959000Z
```

`offset` is relative to the anchor. `remainingAfter` says how much of the thread the window did
not cover, so a long thread stays reachable in one more hop.

### `memory({action: "verify", name? , text?})`

**Check a claim against git instead of judging its wording.** The corpus records what was *said*;
whether it *happened* is a question about the world, and for engineering claims the world keeps a
record. A cited **SHA** — the unique fingerprint git gives every commit, `47f71d3` and the like,
naming one specific saved change — either exists, landed on the mainline, on a date, touching
files, or it does not.

```
memory({action: "verify", name: "x-df6d25fe-20260818T214812690Z"})
  -> c509e0f [recall-mcp] 2026-08-18  ON MAINLINE  "dream + auto-ingest: a correction signal…"  2 files
     3c1a440 [recall-mcp] 2026-08-18  ON MAINLINE  "auto-ingest: the debounce must run BEFORE the lock"  2 files
```

`latest` and `thread` rows carry `verifiedCommits` automatically wherever a cited SHA checks out.

- **Measured coverage:** 404 of 2,319 exchanges (17%) name a real commit. 707 hex-shaped
  candidates collapse to 355 actual commits, so shape alone proves nothing and every token is
  checked against git.
- **Repos are configured, never inferred** — set `MEMORY_GIT_REPOS` to a colon-separated list.
  Unconfigured, this stays silent rather than guessing: this server lives in a different repo from
  the codebase the corpus is about, and guessing would answer confidently about the wrong project.
- **`onMainline` is separate from existence.** A commit can sit in the object store after being
  amended away, or live only on an abandoned branch. "It exists" and "it shipped" are different
  claims, so both are reported.
- **Absence proves nothing.** A row with no `verifiedCommits` cited no SHA.

### The reverse join — git → corpus, on time

Every check above reads a commit SHA *out of* an exchange. That only works when the conversation wrote one down, and measured on a known day it usually
doesn't: **of 12 commits made during one session, that session's text named 2.** The commits happen
inside tool calls, while capture records the prose around them — so the identifier normally never
appears in the text at all. Reading the corpus harder cannot recover what was never written.

Time can. A conversation has timestamps and so do commits, so the join needs no SHA, no vocabulary
and no judgment:

- **`thread`** returns `commitsDuringWindow` — what landed in the configured repos while that
  stretch of conversation was happening. This turns *"I'll commit the fix"* — a promise, and the
  hardest thing in a corpus to resolve — into the record of whether anything actually landed.
- **`latest`** returns `corpusCurrency` — how far behind the world the corpus is, as a count:
  *"N commits have landed since the newest exchange was written."* The guidance already says the
  last word isn't current truth; a sentence is easy to skip and a number isn't.

**Evidence, not proof**, and labelled that way: a commit inside the window may be unrelated work,
and related work can land days later. It narrows *"did this ever happen"* to *"here is what
happened at that moment"*.

### Measuring it

```
npm run analyse-queries   # what callers actually did, and whether retries recovered
```

`eval:state` (**author's tree only — not in the published package**) runs `test/state-questions.json`, whose answers were **written down before the corpus
was queried** — grading after seeing results produces a test that passes for the wrong reason.
Each case also carries a `proseControl` that is expected to *fail*; those controls are the
measurement behind "query a term filter with identifiers, not prose". Baseline: 6/6 answered,
4 of 6 controls failing as expected. It needs the local `store/` corpus, which is gitignored, so
it is deliberately not part of `npm test`.

### `memory({action: "neighbors", name})`
The `[[wikilink]]` graph, free relevance expansion:
- `outbound` — links this memory makes
- `inbound` — backlinks from other memories (`verify-protocol` has 11)
- `unresolvedLinks` — `[[slugs]]` with no matching file
- `semantic` — top-3 nearest by cosine, which surfaces relatives nobody linked

### `memory({action: "demote", name})` / `memory({action: "promote", name})`
Two-tier mechanics. `demote` sets `metadata.tier: archive` in the file's
frontmatter, creating a frontmatter block if the file has none. `promote`
removes the line.

**Your body text is never deleted or moved** — only that one metadata line changes.

The round trip is byte-for-byte reversible **only if the file already had frontmatter**. If it
had none, demoting creates a frontmatter block (including a `description` synthesised from the
body), and promoting afterwards removes the tier line but leaves that block behind. The body is
untouched either way. Files with no frontmatter are common enough that this is worth knowing
before you demote one.

Hot tier = everything not archived. Anything `MEMORY.md` lists is hot by definition, so demoting
a memory that `MEMORY.md` still names is **refused** rather than silently reverted; the response
says which.

---

### `memory({action: "get", name, outline?, section?, maxChars?, offset?})`

A `get` of the 103 KB build checklist used to blow the MCP output limit outright — so the tool
could not read the documents it exists for, and the caller fell back to `cat`. Three ways in:

| | |
|---|---|
| `outline: true` | headings only, with sizes and offsets. One cheap call to see what is in there. |
| `section: "## Gate #24"` | that heading's whole block, to the next heading of the same or higher level. **The primary read path for a large memory.** |
| `maxChars` / `offset` | the bounded fallback. Default 20,000, and the outline rides along so one call is enough to aim the next. |
| `brief: true` | the text and where it came from — `name`, `path`, `body`, and the truncation bookkeeping — without the ~25 provenance and freshness fields. |

Every truncated response carries `totalChars`, `returnedChars` and `truncated`. A slice that looks
like a whole document is how a caller concludes something is absent when it is merely past the cut.

Those three fields survive `brief: true` as well. Brevity may drop provenance; it may never drop
the statement of what was left out.

The full response is the right default when you are deciding whether to **trust** a memory — who
wrote it, when, from which account. `brief` is for when you have already decided to read one and
just want the content: most often after a search says the corpus may hold your answer in other
words and tells you to open the best weak match. It saves a fixed ~1 KB per call, which is
marginal against a long document and most of the response against a one-paragraph note.

Slicing happens **after** the secrets scrub, so paging cannot reassemble a removed region.

> **Fenced code is not a heading.** This corpus is full of shell snippets whose lines begin
> `# 2. ONLY the intended entries changed…`. Read naively those are level-1 headings, and
> `## MASTER PRE-SHIP GATES` returned **426 chars instead of 26,785** — it ended at the first shell
> comment. The outline went 94 → 50 headings, level-1 count 94 → 1.

### `memory({action: "import", path, dry?, domain?, name?, category?, replace?})`

Point it at an **absolute path** — a file, a folder, or a ChatGPT export — and it brings those
memories in. Eighteen formats, no new dependencies:

```
md markdown txt text log csv tsv json zip rtf rtfd doc docx odt html htm webarchive pdf
```

`textutil` (macOS) covers the office and HTML formats and `pdftotext` covers PDF; **archives need
nothing** — `lib/zip.js` reads them in-process with `node:zlib`. **A format whose converter is
missing is refused by name with the reason** — never imported as binary that would poison every
search touching it. A ChatGPT export is recognised (`conversations.json` or its `.zip`) and its
`mapping` **tree** is walked in `create_time` order, because a branched conversation has no single
linear list.

`converters` in the response reports the platform, the probe used (`where` on Windows, `which`
elsewhere) and what each converter actually is on this machine.

- **Refuses** any item containing a credential, and names it. A plaintext secret in a corpus is
  permanent in a way its author rarely intends.
- **Never overwrites**, so re-running is safe — it reports how many were already imported.
- **Skips nothing silently**: too-short, refused and unreadable are each counted and named.
- `dry: true` writes nothing and **says so in the future tense**: `written: 0`, plus `wouldWrite`
  and `wouldWriteNames` for what a real run would file (and `wouldReplace` in place of `replaced`).
  The skip counters are unchanged, so a dry run still tells you what it would pass over.
- **An argument this tool does not know is refused**, by name, on any action that writes —
  `import`, `capture`, `index`, `demote`, `promote`. Read actions stay tolerant.
- **It starts the index build itself.** An import that wrote at least one file kicks the async
  index job for the corpus it wrote to and returns `indexJobId` (+ `indexScope`); poll it with
  `index_status`. Until it finishes the new documents are served from the store rather than ranked.
  A dry run starts nothing, an import that wrote nothing starts nothing, and a build already
  running for that corpus is JOINED rather than raced — the response then carries
  `indexAlreadyRunning: true`, because that build may have begun before your files landed.
  `MEMORY_IMPORT_AUTOINDEX=0` switches the kick off; the direct read still serves the documents.

> **Why the import builds the index.** Measured over eight import shapes, twice: every imported
> document was still unindexed 300 s later and would have stayed so indefinitely. Nothing rebuilds
> a *curated* index — the 5-minute walker reconciles staging only, and the inline rebuild refuses
> anything past 8 changed files as a full rebuild in disguise. Retrieval never broke, which is why
> it went unnoticed: the answers came through the direct store read, a substring scan that answers
> a token but not a paraphrase and re-reads those files on every query.
>
> **Why an archive needs no `unzip`.** The converter probe ran `command -v` through
> `shell: '/bin/bash'`, which does not exist on Windows: the spawn failed, every converter read as
> missing, and `.zip` import was refused there outright — with the one public check that covers it
> skipping itself on `windows-latest` for want of the `zip` binary to build its fixture. The probe
> is now `where`/`which` spawned with no shell, archives are read in-process, and the fixture is
> written by `writeZipSync`, so the check runs on every platform. A stored symlink is still
> restored and still refused if it points outside the archive, and an entry name that climbs out of
> the destination is refused by name.

> **Why a dry run may not say `written: 3`.** It used to. Zero files reached disk and the response
> said `written: 3` with three filenames, because the dry branch reported its *intention* through
> the same field a real write uses; only `dry: true` and one sentence of prose disagreed with the
> other two signals. A response may not make a claim it cannot back, so the tenses are now separate
> fields and no field is true of both a dry run and a real import.
>
> **Why a write refuses an unknown argument.** `memory({action:'import', path, dryRun:true})` — a
> typo for `dry` — **imported for real**: the tool is registered with a plain object schema and zod
> strips unknown keys, so the flag was deleted before the handler ran (measured: `written=2`,
> `dry=false`, curated 19 → 21). The schema now passes unknown keys through so the handler can see
> them, and a write action refuses one by name, suggesting the argument you meant. A stray key on
> `search` still costs nothing and is still tolerated — refusal is for the places where a near-miss
> costs files.

`scripts/import-memories.js` is the same thing on the command line, and additionally runs the index
and a first `dream` pass for you.

### The corpus knows what kind of corpus it is

This server was built against one software project, and its advice said so: *"QUERY WITH
IDENTIFIERS, NOT PROSE"* was told to every caller. That is measured advice — **on a code corpus**.
Told to someone whose memories are notes for a novel it inverts: they have no SHAs, no flags and no
paths, and prose is the only thing they can search with.

Advice now resolves in three layers, most authoritative first:

1. **An explicit `domain:`** — `code | writing | business | research | planning | prose | mixed`.
2. **The shape of the query** — a SHA, path, `CONSTANT_CASE` or `--flag` means technical retrieval
   whatever the corpus is.
3. **The corpus profile** — derived once per index by *counting structural markers*, never by
   reading a document and classifying it. Reported as `corpusProfile` with a confidence.

> **Why both layers.** Counting is the floor that needs no cooperation, so a corpus somebody just
> imported gets sane advice on its first query. But counting can only separate code from not-code:
> measured across eight corpora, a novel, a business plan, case notes, research notes, recipes and a
> book *about* software **all score `codeScore` 0**. Only a caller who names the domain can separate
> those, which is why `domain:` is first-class rather than a fallback.
>
> The first threshold was `codeScore >= 0.35`, fitted to this repo's own curated corpus (0.43). It
> scored **3/8** on pre-registered corpora. Real separation is an order of magnitude lower — prose
> 0–0.017, code 0.117–0.43. Re-derived on the principle rather than the example: **8/8**.
> `test/domain-corpora.json` pins all eight.

### `memory({action: "index"})` returns a job

Indexing runs **off** the request. It used to `await buildIndex` inline — ~73 s for curated, minutes
for staging — so the stale warning told callers to run `index` and running it returned
`Error: Request timed out`. A tool must never recommend an action it cannot itself complete.

```
memory({action: "index"})                        -> { started: true, jobId }   (~675 ms)
memory({action: "index_status", jobId})          -> { state, indexes, skipped }
```

One build per index **file** at a time — a second concurrent `index` for the same scope reports
`already being built by job …` rather than racing it. `wait: true` keeps a blocking path for the CLI
and tests.

## Freshness — an index is a cache of a directory

**The incident (2026-08-19).** The curated index was last built at 06:18. The
corpus files changed at 07:13 and again at 20:46. Every search for the rest of
the day answered from the 06:18 snapshot, silently. A session in another chat
built a conclusion about the state of the project on top of those snippets — and
compounded it by reading each result's `modified` field, which is the file's
mtime *at index time*, as though it were a live stat.

Two defects: no invalidation rule, and no provenance. Both are fixed.

**CHECK.** Before answering, `search` stats the corpus files and compares each
one against the mtime the index recorded for it. Exact rather than heuristic:
edited, added and deleted files are each detected on their own terms. Measured on
this Mac — 122 curated files: **1.00 ms cold, 0.69 ms warm**; the 2,104-file
staging store: 11.5 ms cold, 8.7 ms warm. Cached for 3 s so a burst pays once.

**REPAIR.** If anything moved, the existing incremental indexer
(`lib/index-store.js`) runs *inline, before the answer*. There is one indexer in
this repo and the guard calls it; nothing is reimplemented. A one-file edit costs
~3 s end to end (`120 files reused, 1 re-embedded`).

**ADMIT.** When the repair cannot be cheap, the query is **not** blocked. It is
answered from the stale index and stamped:

```jsonc
{
  "indexStale": true,
  "indexBuiltAt": "2026-08-20T05:33:03.019Z",
  "staleFiles": 1,
  "staleWarning": "STALE INDEX — these results come from an index built at
     2026-08-20T05:33:03.019Z, and 1 corpus file(s) have changed since:
     1 edited (commit-changes-when-done.md). Not repaired inline because …
     Run memory({action:\"index\"}) before trusting these snippets, and note
     that each result's `modified` is the file's mtime AT INDEX TIME."
}
```

The repair is refused, by design, when it would not be cheap:

| condition | why |
|---|---|
| header refused | every vector would have to be recomputed — that is a *full* build, minutes |
| no index on disk **and** more than `FRESHNESS.firstBuildMaxFiles` (40) files | a full build. Under the bound it **is** built inline — the day-2 case, when another project has just written its first memories |
| more than `FRESHNESS.maxInlineFiles` (8) changed | a full rebuild in disguise; 8 ≈ 40 s worst case, 25 ≈ two minutes |
| the embedding model will not load | the rebuild would produce a BM25-only index — worse than the stale one |
| the last inline rebuild failed < 60 s ago | otherwise a broken model turns every query into a fresh failed build |
| `MEMORY_INLINE_REINDEX=0` | kill switch; keeps the check and the stamp, drops the rebuild |

One rebuild at a time per index file (a burst of queries does not start a burst
of writers over the same 16 MB), and a failure never fails the search.

**Staging** is checked and stamped the same way — the mtime comparison is just as
cheap there — but it is **not** repaired inline: its rebuild writes 130 MB in
~14 s and its own ingest hook owns it. Its stamp adds `lastIngestAt`, from
`store/.last-ingest.json`, because "when did material last arrive" is the more
useful question for that corpus.

**Which build is answering.** Node caches every module at spawn, so an MCP
process the client started this morning is still running this morning's code no
matter how often the repo is edited — and nothing used to say so. The server now
logs its git SHA, branch, pid and start time to stderr at startup, and stamps
`serverVersion` / `serverStartedAt` on every search response. **A running server
keeps the old code until the client is restarted** (Claude Desktop: full ⌘Q and
relaunch; Claude Code: a new session).

---

## Four work corpora + the library, one index each

| corpus | roots | index | written by | tier | writable | in `'all'` |
|---|---|---|---|---|---|---|
| `curated` | the canonical `~/.claude/projects/<this project>/memory` | `.memory-index.json` | Claude, by hand | hot | yes | yes |
| `projects` | **every OTHER** `~/.claude/projects/<project>/memory` | `.projects-index.json` | Claude, by hand | hot | yes | yes |
| `staging` | `store/` | `.staging-index.json` | `scripts/auto-ingest.js` | archive | yes | yes |
| `handoff` | any dir named by `MEMORY_HANDOFF_DIRS`, files matching `HANDOFF*` / `PHASE*` / `*-HANDOFF*` | `.handoff-index.json` | **nobody — read-only** | archive | no | yes |
| **library** (one corpus per category) | `$MEMORY_LIBRARY_DIR/<category>/` | `.lib-<category>-index.json` | `import` with `category:` — **read-only otherwise** | archive | no | **never** |

`scope: "all"` searches each **work** corpus against its own statistics and
returns them as separate ranked sections under `.groups`. **They are never
blended**, and that is measured twice:

* Putting 499 auto-ingested exchanges in the curated index cost three probes
  their answer (22 → 19) and MRR **0.826 → 0.681**.
* Putting the 14 handoff documents in the curated index cost MRR
  **0.8194 → 0.7986** and one absence verdict — while taking **zero** top-3
  slots. Nothing was crowded out. The damage was done entirely by
  `referenceChunks`, the corpus-derived p90 chunk count the long-document
  correction normalises against: 14 long documents moved it 16 → 19, which
  raised the dense score of every curated memory above 16 chunks and pushed
  `deal-reg-email-rules` to 0.3842 against an absence floor of 0.38 — a 0.0042
  margin, and the server could no longer say *"I have no memory of a Postgres
  migration"*.

* Putting 15 **other-project memories** in the curated index cost MRR
  **0.8125 → 0.7917** and a rank-1 (measured 2026-08-20; see the next section).

With the handoff documents in their own index, the 32-probe benchmark is
**bit-identical to the curated-only baseline**: MRR 0.8194, absent 4/4, exact
10/10, verbatim 6/6, enum 33/41, and not one rank changed.

### The `projects` corpus — other projects' memory folders

Claude keeps memories **per project** (`~/.claude/projects/<project>/memory`), and
this server is pointed at one of them. Every *other* project's folder is
discovered automatically, and until 2026-08-20 it was routed into **staging** by
`primary: false` — so hand-written rules from another project were ranked as
though they were raw transcript exchanges (archive tier, no hot boost) and were
unreachable at the default scope. Exactly one memory folder exists on this
machine, so the defect had never fired. This is the fix before it arms.

They are **curated-type content**: hot tier, `demote`/`promote` allowed, their own
`account` label per file, their `project` folder carried on every hit. What they
do **not** get is a share of the curated index, and that was measured the same way
the handoff corpus was — with a 17-file fixture second project
(`test/fixtures/projects/…-cli-mcp-server/memory`, 15 indexable) pointed at by
`MEMORY_EXTRA_PROJECT_DIRS`:

| metric | curated only | +15 other-project memories **inside** the curated index |
|---|---|---|
| MRR (24 ranked probes) | **0.8125** | **0.7917** |
| probes in top-3 | 22/24 | 22/24 |
| absence verdict | 4/4 | 4/4 |
| enum items | 34/41 | 34/41 |
| P2 *"what do I have to run after editing the huge single-page web file"* | rank **1** | rank **2** — a memory from the other project took rank 1 |
| every other probe's top score | — | moved, −2.3% to +6.3%, with no content changed |

Two separate damages, worth telling apart:

* **Shared statistics** — the one that generalises. Not one curated document
  changed and *every* probe's score moved (V2 +5.1%, E9 +4.2%, N2 −2.3%): 15
  documents joining 122 move BM25's average document length and every idf, so
  `queryIdealScore` moves, so the absolute keyword scale moves, so every fused
  score moves. That is the same mechanism that cost the handoff experiment an
  absence verdict on a 0.0042 margin. Here it crossed no floor. There is nothing
  to say it would not next month.
* **Competition** — the specific one. P2 asks about *this* project's UI-syntax
  rule and a memory from *another* project outranked it. Not by being better; by
  being in the same ranked list.

Kept separate, the curated index built with the fixture present is bit-for-bit
the control: `corpusHash 56b48c09…`, 122 docs, 1,586 chunks, all three unchanged.
The fixture's 15 documents are a 33-chunk index of their own with its own
`referenceChunks` (4, against curated's 16).

**Reachable without a scope argument.** A memory in its own index cannot be found
by a default-scope search, and a standing rule that needs an explicit `scope` is a
standing rule nobody finds. So the advisory router **widens to `scope: "all"`
whenever a project corpus exists** — the same "widen, never narrow" rule the
handoff phrasing uses, and free here because `all` returns each corpus as its own
ranked section. With one memory folder on the machine (today) nothing about
routing changes at all.

**Read the `project` field.** A rule from another project is a rule about
*another project*. Every search row and every `get` carries `project`, `account`
and `corpus`; `project: "this"` restricts to the canonical folder.

#### Day 2 — what happens when a real second project appears

Zero configuration. A session run from another project writes
`~/.claude/projects/<other>/memory/foo.md`, and:

1. `discoverProjectMemoryDirs()` finds the folder on the next call — no list to
   edit, no env var to set. It becomes a `projects` root, namespaced by the last
   three dash-segments of its folder name (`store/foo.md`-style ids, so two
   projects may hold the same basename).
2. The **first search** finds the `projects` index missing and **builds it inline
   before answering** — bounded at `FRESHNESS.firstBuildMaxFiles` (40) files, ~2 s
   for a 15-document project. Over that bound the search is answered and stamped
   `indexStale` with the sentence saying what to run. (Curated at 122 files and
   staging at 2,100 are both far over the bound, so their behaviour is unchanged.)
3. `memory({action: "index"})` rebuilds it by default (`curated` + `projects` +
   `handoff` — the three hand-edited corpora; staging stays opt-in).
4. The router widens, so the new memories are reachable with no scope argument.
5. `scripts/auto-ingest.js` rebuilds `rootsForCorpus('staging')`, which no longer
   contains project roots — so the new folder is **not** double-ingested as
   transcript material.
6. Its own `MEMORY.md` acts as *its* tier-1 index (`inMemoryIndex`, the larger hot
   boost). The **bare** name `MEMORY` still resolves to the canonical one — every
   project has a `MEMORY.md`, and `loadCorpus` warns about the shadowing — so ask
   for the other one by its namespaced id: `get({name: "cli-mcp-server/MEMORY"})`.

One caveat that is not code: a **running MCP server keeps the code and the module
state it was spawned with**. A client started before this change picks it up only
after a restart (Claude Desktop: full ⌘Q; Claude Code: a new session).

### The library — category-isolated reference corpora

Books, manuals, policies: imported **reference material**, which is a different
thing from a memory. Daniel's rule (2026-08-26): nothing imported may dilute or
even touch work retrieval unless a search names it. Both halves are enforced:

* **Isolation by construction.** Each immediate subdirectory of
  each library category is its own corpus with its own
  `.lib-<category>-index.json` — own BM25 statistics, own `referenceChunks`,
  own profile. The suite's a48 group proves the stronger claim **bit-identically**:
  curated `corpusHash`, every RECALL name *and score*, and every absence verdict
  are byte-for-byte the same with library corpora present as with the whole
  class switched off (`MEMORY_LIBRARY=0`) — with an absence-probe term planted
  inside the library fixture the entire time.
* **Reach isolation.** `'all'` stays the four work corpora, and the router never
  volunteers a category. A category is searched **only when named** —
  `scope:'books'`, `scope:['all','books']` — or via `scope:'everything'`
  (work + every category). Unknown scope names error, listing what exists.
* **Read-only** (`doTier` refuses; import's own fs path is the sole writer),
  **archive tier**, **never rebuilt inline** (a changed book is a full re-embed;
  rebuild with `memory({action:"index", scope:"<category>"})`).
* **Import routes and refuses.** `import` with `category:'books'` files into the
  category (created on demand). Anything over 200 KB of text, or book-shaped
  (PDF), **without** a category is refused before any write — the accident this
  prevents is a book quietly landing in curated. `replace:true` supersedes a
  re-issued document (old version → `<category>/archive/`, stamped
  `supersededAt`, out of the flat scan, never deleted).
* **Structure is recovered at import.** PDF form feeds become `## p.N` page
  anchors (and running page headers are stripped); docx/html headings become
  real `##`; a plain-text book's `CHAPTER` lines are promoted (last occurrence
  of a duplicated designator — a Gutenberg ToC stays plain text). The existing
  section splitter then chapters the document, so a manual answer cites
  `ts-x73a-user-guide#p-7` — a page a human can open.
* Optional `memory-library/<category>/.category.json` (`{domain, description,
  note}`) declares the category's domain for the advice layer — a statute and a
  novel are statistically identical prose. Starter categories: `books`,
  `manuals`, `policy`, `legal`.
* Validation is pre-registered in `test/library-questions.json` — bar, grading,
  and the measured result (invented facts 12/12, manual pages 11/12, absence
  10/10, leaks 0; famous-book chapter precision 8/12, honestly short of its 80%
  bar and recorded as a known limitation).

### The handoff corpus

The institutional handoff documents record the state of a phase of work for
whoever picks it up next. They lived outside both corpora, so no query could
reach them — *"what was the state of the corpus refresh"* returned the memory
summary and never the handoff holding the detail. Daniel approved indexing them
(2026-08-19). Fourteen documents, 217 chunks, 2.2 MB.

* **Read-only, structurally.** `readOnly: true` travels from the root onto every
  document, and `doTier()` — the only writer in the whole tool — refuses. No
  action can promote, demote, edit or delete one; the test suite asserts the file
  is byte-identical after both attempts.
* **`type: "handoff-doc"`**, with the absolute `path` as provenance (their
  `project` is deliberately `null` — a handoff document is cross-project, and a
  null project is never filtered out).
* **Secrets policy applies unchanged.** The pattern guard fired on a bearer
  token in one of them at index time and redacted it.
* **Same staleness guard.** These documents change; the check and the inline
  repair cover them exactly as they cover curated memories.
* **Findable by default.** They are in their own index, so a default-scope search
  cannot reach them — which would leave them exactly as unfindable as before. The
  advisory router therefore *widens* to `scope: "all"` on handoff phrasing
  (`handoff`, `handed over`, `phase 2`, `where did we leave`, `next session`,
  `state of the project`). It widens; it never narrows, so the curated section is
  returned untouched alongside.

---

## Graph spread — the [[wiki-links]] finally do something

Every curated memory carries links a person wrote on purpose, and retrieval
never read them. After the three legs fuse, each of the top 10 documents now
lends `alpha` (0.15) of its score along its links and backlinks — but only to
a document the query **already reached**, and only if that document clears a
similarity gate of its own (0.25). Single hop, computed from pre-spread
scores, so a cycle cannot amplify itself. The absence verdict is computed on
the **pre-spread** ranking: spreading reorders, it never answers a refused
question.

Measured against a bar fixed before the code existed
(`test/graph-spread-preregistration.md`): curated gold **9/10 → 10/10**, MRR
**0.850 → 0.950**, absence 4/4 and the razor pair unmoved, **zero
regressions**, holding across a plateau of five adjacent grid points. The
10th was "when should I escalate…", which had failed since before the
truth-and-recall campaign began: `verify-protocol` sat at rank 5 while two
documents that literally contain `[[verify-protocol]]` sat above it. **ON by
default**; `MEMORY_GRAPH_SPREAD=0` disables. 🟥 `alpha 0.30` costs two gold
answers — the cliff is one grid step from the default.

## Probes — machine-checkable current truth

A memory can record its own check: `metadata.probe` (a command from the CLOSED
eleven-predicate vocabulary in `lib/probes.js`) plus `metadata.probe_expected`,
compared by equality — arithmetic, never language. The nightly dream pass
sweeps them (also `memory({action:"probe_status", run:true})`), verdicts
(`FRESH | STALE | UNKNOWN | UNPROVABLE`, UNKNOWN-never-STALE on any error) go
to the gitignored sidecar `.probe-results.json`, and memory files are never
rewritten. Exact frontmatter grammar + one worked example per predicate:
`test/PROBE-SYNTAX.md`. Dial: `MEMORY_PROBE_LEVEL off|cheap|all` (default
`cheap` — local file/git/date predicates only; the nightly sweep runs there).

**Surfacing (Phase 3b).** Twenty claims sampled across the stale-belief
taxonomy were hand-adjudicated against reality and written down BEFORE the
evaluator ever ran on them (`test/probe-calibration.json`, bar: ≥12/20 agree
and ≤1 false-STALE). The machine agreed on **18/20 with zero false-STALEs**,
so search results now carry a `probeVerdict` and the response a
`probeVerdicts` summary. **Advisory only, and structurally so:** the
attachment happens in `lib/probe-surface.js`, called from the tool boundary
*after* `search()` has returned — the ranking libraries contain no probe
identifier at all, and the suite pins that a STALE verdict leaves the
`[name, score]` list byte-identical. Kill switch `MEMORY_PROBE_SURFACE=0`
(the sweep keeps running; only the annotation stops).

**Proposals (Phase 3c).** The nightly dream pass also *drafts* probes from
prose it can already read as a claim — a ship tag beside its sha, a loopback
endpoint, an absolute path — and queues them under `probe-proposal` with the
evidence line and the exact frontmatter to paste. It never writes them and it
cannot run them: `lib/probe-proposals.js` imports no evaluator and no process
API, and the sweep only reads frontmatter, so an unconfirmed proposal is
invisible to it by construction. The rules are narrow on purpose (curated
corpus only, loopback/private hosts only, no `/tmp`, nothing inside a code
fence, and the expected value must appear in the prose): the first
unrestricted draft produced 1,660 proposals over 659 documents — including a
nightly GET at a payment gateway. Today's corpus yields **19 proposals over
11 memories**.

## Will this touch my memories?

Short answer: it writes frontmatter stamps (`tier`, `modified`, provenance), creates new files on
`import`, archives rather than overwrites on `import … replace`, and **never deletes anything from
your memory folder**. Every one of those writes goes through one door that refuses any edit whose
body differs, snapshots the previous bytes to `.memory-snapshots/` first, and writes atomically.

If you would rather have the guarantee than the argument, set **`MEMORY_CURATED_READ_ONLY=1`** and the
server writes nothing to your memory folder at all — it still indexes, searches, and captures
conversations into its own `store/`. Nothing in retrieval depends on the stamps.

The full inventory, the mutation-tested guards and the recommended setup for imported memories are in
**[MEMORY-SAFETY.md](MEMORY-SAFETY.md)**.

## Upgrading to 1.6 — exchange names changed on disk

Auto-captured exchanges used to be named by their **position** in the transcript
(`x-<session>-0042`). 1.6.0 names them by the **time the question was asked**
(`x-<session>-20260903T054233800Z`). Position was the root of a week of store defects — a changed
extractor rule renumbered hundreds of files and left duplicate memories behind, and a deletion bound
computed from the ordinal removed a real one. A name that belongs to the exchange cannot do that.

If you have an existing store, migrate once (the server keeps reading either shape in the meantime,
and files sort into the same order before and after):

```
npm run migrate:names            # dry run — prints the plan and every pre-check, writes nothing
npm run migrate:names -- --apply # renames, rewrites name: and Previous:, verifies, refuses on any failure
memory({action: "index", scope: "staging"})   # then rebuild the staging index
```

Back up your `store/` first — it is gitignored, so that copy is the only one. The migration refuses
to apply unless every file's timestamp compacts cleanly, no two files would share a name, and the new
order equals the old order in every session; afterwards it verifies the count is unchanged, every
`name:` equals its filename, no `Previous:` link dangles and nothing old-shaped remains.

Two related additions: `npm run audit:store` compares the store against the transcripts it came
from (orphans, duplicate bodies, order, dangling links; run it whenever something looks off), and
`npm run release:capture` + `npm run install:capture-hooks` make the capture hooks run a **released
copy** of the code under `dist/capture/` instead of your working tree — so an edit you are still
testing can never touch your store on the next hook tick.

### The hourly store audit — and the one copy that is not derived

Every other freshness channel this server has trusts something derived. `uncapturedSessions`
compares a transcript to the **debounce stamp**; `captureHealth` reads the **run log**; the recall
canary compares the store to the **index**. When the stamp itself lied — a test fixture wrote
`store/.last-ingest.json` for a live transcript at its full size, so the next real capture decided
nothing had grown and skipped — six exchanges were lost and all three said everything was fine.

So once an hour the loaded server spawns `scripts/store-audit-tick.mjs`, which compares the
**transcript to the store**: it re-runs the real extractor for the 20 most recently touched sessions
into a scratch directory and diffs the filenames. That comparison reads the stamp never, which is
the point. A `missing` file younger than the grace window is normal (the exchange being written
right now is deferred by design); one older than it is an exchange that had every chance to be
written and was not, and the tick repairs it by re-running the extractor with the stamp ignored,
under the capture lock, then rebuilds the staging index. Every tick appends one line to
`store/.ingest-runs.jsonl`, and `captureHealth` — already stamped on every staging answer — now
carries both the audit's verdict and the last row of `.vanish-report.jsonl` (indexed documents that
disappeared from disk), which until now nothing read.

| variable | default | what it does |
|---|---|---|
| `MEMORY_STORE_AUDIT_MIN` | `60` | minutes between audits; `0` switches it off |
| `MEMORY_STORE_AUDIT_DELAY_MIN` | `5` | how long after boot the first audit runs |
| `MEMORY_STORE_AUDIT_GRACE_MIN` | `15` | younger than this, a missing exchange is normal, not an alarm |
| `MEMORY_STORE_AUDIT_MAX_SESSIONS` | `20` | how many sessions one tick looks at, newest first |
| `MEMORY_STORE_AUDIT_HEAL` | on | `0` reports and repairs nothing |
| `MEMORY_VANISH_REPORT_DAYS` | `7` | how long a vanish row stays news |

The same tick takes a **daily snapshot** of `store/*.md` — one gzipped JSONL, `{name, mtimeMs, body}`
a line, in `store/.snapshots/store-YYYY-MM-DD.jsonl.gz`, keeping fourteen and skipping any day the
store has not changed. It exists for one reason: Claude Code prunes transcripts after 30 days by
default, and on day 31 the store stops being a derived artefact and becomes the only copy. To put
files back:

```
node scripts/store-restore.mjs store/.snapshots/store-2026-09-05.jsonl.gz --dry    # what it would do
node scripts/store-restore.mjs store/.snapshots/store-2026-09-05.jsonl.gz          # missing files only
node scripts/store-restore.mjs <snapshot> --only x-b58a69af-20260905T044521647Z.md # just one
node scripts/store-restore.mjs <snapshot> --force                                  # also overwrite
```

It restores **missing files only** unless you ask for `--force`: the reason to run it is that
something removed files, and overwriting the ones still present would roll the store back to the
snapshot — turning a partial loss into a total one. `MEMORY_STORE_SNAPSHOT_HOURS=0` turns snapshots
off; `MEMORY_STORE_SNAPSHOT_KEEP` changes how many are kept.

## Versioning the memory folder

The curated memories had no version control, so a bad overwrite was unrecoverable — and the folder
already held two hand-made `.bak` files someone created because there was no other way to undo a
change. `scripts/commit-memories.js` gives it a history:

```
npm run memories-status    # what has changed since the last commit
npm run commit-memories    # commit it now (the Stop hook does this automatically)
```

It runs from the `Stop` hook as its **own** entry, not appended to the ingest command — if they
shared a shell line, a git failure would take memory *capture* down with it, and capture matters
more than versioning. At most one commit per turn, only when something changed, and every path
exits 0 so a hook can never fail a turn.

To recover a clobbered memory:

```
git -C "$(node -e 'import("./lib/config.js").then(m=>console.log(m.memoryDir()))')" log --oneline -- some-memory.md
```

then `git show <sha>:some-memory.md`.

**Local only, deliberately.** A memory corpus tends to accumulate credentials — an SSH password
pasted into a note, a token in a runbook. On disk that is a pre-existing fact you can fix; in a
*pushed* history it is permanent and off-machine, surviving any later deletion unless the history
is rewritten. The script therefore never adds a remote, never pushes, and **refuses to run** if a
remote is configured while an *unmistakable* secret is still present, naming the offending files.

"Unmistakable" is deliberately narrower than the redaction vocabulary, because this decision blocks
you from versioning your own notes and a false positive there is expensive. Three shapes block a
commit: `sshpass -p '…'`, a `-----BEGIN … PRIVATE KEY-----` block, and an AWS `AKIA…` key. A line
like `password: hunter2` is redacted everywhere it could be *served* — the index, search results,
`get` — but does not block a local commit. The asymmetry with `import`, which refuses such a file,
is intentional: declining to copy a file in is cheap and tells you which one, whereas declining to
record your own history is not. Offsite backup is a separate decision that needs the credentials
moved out first.

## Secrets policy

Assume the corpus will contain plaintext credentials sooner or later. Four mechanisms, each enforced
**at index time and again at output time**:

1. **Filename denylist** — `secrets-exclude.json` → `excludeFiles`. A file
   listed there is never indexed; `get` and `neighbors` return a refusal.
   Ships empty: add your own, and note that the list itself is public, so name
   files by path rather than by what they contain.
2. **Frontmatter opt-out** — `metadata.secret: true` gets the same treatment.
   Re-checked on every `get`, so marking a file secret takes effect immediately,
   before any rebuild.
3. **Section scrub** — for the case where one *section* of an otherwise useful
   file is the problem. Name the file and its heading in `sectionScrub` and the
   file is indexed with that section stripped, with `get` returning the scrubbed
   version. Configured per machine; ships empty.
4. **Pattern guard (backstop)** — password-shaped text is redacted to
   `[REDACTED:<class>]` before the index file is written and before any tool
   response leaves the process, with a `WARN` naming the stage it fired at.
   The class names the pattern that fired (`credential-shaped`, `token-shaped`,
   `key-shaped`, `known-credential` — a CLOSED vocabulary; an unlisted class
   fails the config load) and never encodes anything about the redacted
   content. Older corpus text still carries the bare `[REDACTED]` form; both
   generations are inert to re-redaction.

Mechanism 4 exists because curated lists go stale. It currently catches six
real chunks drawn from two large memories in the author's corpus
— files nobody thought of as credential-bearing.

**No plaintext credential lives in this repo.** `secrets-exclude.json` stores
known literals as sha256 hashes of their lowercased form, and the tests detect
leaks the same way. A test that hard-coded the password to grep for would
itself be the leak.

If `secrets-exclude.json` is unreadable, the server **fails closed**: every file
is treated as excluded rather than risk indexing an unfiltered corpus.

### A password said in a sentence
The shapes above are machine shapes — a header, an assignment, a prefixed key. The shape a
*person* uses is a sentence, and until 1.7.3 the guard had no rule for it: *"My test password is
Hunter2-Xk9!pass and my key is AKIAIOSFODNN7EXAMPLE"* stored the key as `AKIAIOSF••••••••••••`
and the password in clear, in the memory's description and in its `search`/`latest` snippet.

`password-in-prose` covers it, and stays deliberately narrow. It fires only when a trigger word
(`password`, `passwd`, `passphrase`, `passcode`, `pin`) is followed by a link (`is`, `was`, `:`,
`=`, `->`, `set to`, `changed to`) **and** the value earns it: quoted (any shape — a quote is how
a person says *this is the value*), or 8+ characters carrying a non-letter, or 12+ characters. A
bare lowercase word never counts: measured over 2,952 real exchanges it scored 0 true and 3 false
("provided", "supposed", "extended"), so *"the password is required"* is left alone, and so is
`**provided**` in bold. A trigger inside an inline code span (`` `Password:` ``) is not a link to
whatever follows the closing backtick. Teams' `Passcode: <value>` lines are covered by the same
rule.

The rule also has to survive the guard's **last** sweep, which runs over the *serialized* index —
JSON, where every quote in the corpus is `\"`. The first cut let a backslash be a value character,
so `must not redact \"password is required\"` matched (`required\` is nine characters carrying a
"non-letter"), the escape was eaten, and `buildIndex` correctly refused to write an index that no
longer parsed: `npm run index` exited 1 and the staging index could not be rebuilt at all. A value
character is therefore never `` \ " ' ` , ; . ) } ] > `` or whitespace, and the non-letter that
qualifies an unquoted 8+ token must be a digit or one of ``!@#$%^&*_+-=~?/|`` — never a backslash,
a quote or a bracket. (a94) now round-trips every fixture through `JSON.stringify` and builds a
real index over a corpus that holds an escaped quote.

### A note on `-p`
An early version of the guard redacted any quoted value after `-p` and shredded
106 chunks — `unzip -p "$ZIP"`, `mkdir -p "..."`. The rule is now scoped to
commands that actually take a password there (`sshpass`, `mysql`, `psql`,
`smbclient`, …). A secrets guard that mangles the corpus gets turned off, which
is the real failure.

---

## The embedding contract

`Xenova/bge-small-en-v1.5`, quantized ONNX, 384-dim, mean pooling, L2
normalised. **bge is asymmetric**: the prefix
`Represent this sentence for searching relevant passages: ` goes on
**queries only**; passages are embedded bare. Getting that backwards costs
recall silently — no error, just worse answers forever.

Because vectors are meaningless without the recipe that produced them,
`.memory-index.json` opens with a self-describing header:

```json
{ "formatVersion": 1, "model": "...", "queryPrefix": "...", "pooling": "mean",
  "normalize": true, "dim": 384, "chunkWords": 200, "chunkOverlapWords": 40,
  "chunkCount": 1510, "docCount": 110, "corpusHash": "...", "builtAt": "..." }
```

The loader compares every contract field against the running configuration and
**refuses** the dense half on any mismatch — logging which field disagreed —
then serves BM25-only. It never silently returns vectors built by a different
recipe. Same for an unparseable index: `mode: "unavailable"`, no crash.

If `@xenova/transformers` cannot load at all (not installed, model not cached,
no network on first run), everything degrades to BM25-only **loudly**: an
`ERROR` log with the fix, and `mode` / `degradedReason` on every search
response.

**That last paragraph — the model failing to load *at search time* — is the one
claim here with no test behind it, and it is untested deliberately.** The state
it describes is "a dense index on disk, and no model to embed the query with",
and this codebase cannot reach that state: `lib/index-store.js:266` refuses to
build an index at all when the model is unavailable (Daniel's 2026-08-30 rule —
a stale dense index beats a fresh keyword-only one — with deliberately no env
override, because an escape hatch is how "temporarily" becomes permanent).
Constructing the state in a test therefore means adding exactly the override
that rule exists to forbid, so the branch is left unexercised and said so here
instead. Note the scope: `mode: "bm25-only"` is also reached when the index
header disagrees with the running contract, and *that* path is tested
(`test/run-tests.js:1433`, a deliberately corrupted header). Only the
model-unavailable branch is unproven. What you would see if it fires: one
startup `ERROR` line reading `DENSE RETRIEVAL DISABLED — embedding model
unavailable: …` followed by the fix (re-run `npm run index` with network access
so the model caches), `mode: "bm25-only"` and a `degradedReason` on every search
response thereafter, and rankings that still carry keyword and phrase evidence
but have lost semantic matching entirely — a paraphrase will no longer find a
memory that shares no words with it.

### Model cache
`./.model-cache` (gitignored, ~35 MB). Populated on first `npm run index` with
network access. If the machine has the same model cached elsewhere, copying
`Xenova/bge-small-en-v1.5/` into `.model-cache/` works too — it is a plain
directory of files.

---

## Registration

### Claude Desktop
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/recall-mcp/index.js"]
    }
  }
}
```

If the file already has `mcpServers`, add just the `"memory"` block inside it rather than
replacing what is there.

> **🟥 QUIT Claude Desktop completely BEFORE editing its config; edit; then launch; then
> verify `serverVersion`.** Claude Desktop holds this file in memory and **writes its own
> cached copy back over it when it quits**, so an edit made while the app is running is
> discarded the moment it exits — with no error, and a file on disk that looks untouched.
> Measured on a real machine (2026-09-06): a config edited to 1.7.2 while Claude ran came
> back as 1.6.3 after the next quit-and-relaunch, and the file had reverted to its previous
> contents. Two releases were installed as files and never actually loaded because of it.
> Quit with ⌘Q on macOS, or tray icon → Quit on Windows — closing the window only hides it.

**Claude Desktop also caches MCP tool schemas at connection time.** After the relaunch,
start a **new conversation** before the `memory` tool appears; a conversation that was
already open will not see it.

**Then verify.** Every response the memory server returns carries a `serverVersion` field.
If it names an older version than the one you installed, the edit was reverted — quit
completely and do it again. That field is the only way to tell a saved config from a
discarded one.

### Claude Code
```bash
claude mcp add memory --scope user -- node /absolute/path/to/recall-mcp/index.js
```
Existing Claude Code sessions pick it up on the **next** session, not the
current one.

### That is the whole of capture setup

**A loaded server keeps time.** While the connector is switched on, the server spawns a capture
walk every five minutes — the same `scripts/timed-capture.mjs` you can run by hand with
`npm run capture`. Nothing else is required for conversations to be remembered: **on Windows,
nothing else at all.**

That matters because the two older triggers each miss something, and one of them is macOS-only:

| trigger | reaches | needs |
|---|---|---|
| the server's own timer | every session with uncaptured turns, every 5 minutes | the connector switched on |
| the `Stop` hook | the session that just replied | hook JSON in your Claude settings |
| the macOS LaunchAgent | every session, every 5 minutes | a `.plist`, installed by hand — **macOS only** |

The hook and the LaunchAgent are now **belt and braces**, not requirements. Keep them if you have
them (a hook captures the moment a turn ends rather than up to five minutes later); do not install
them if you do not.

**The exchange being written right now.** A timed walk deliberately leaves the last exchange of a
live turn alone: it is still growing, and writing it every five minutes would re-embed it every five
minutes and make a truncated answer briefly searchable as though it were finished. A hook does not
have that problem — a turn that has ended is finished by definition — which is why the hook never
defers. With no hook installed, though, "the next pass will get it" was never true for a chat that
simply stopped: the last exchange waited for the hourly store audit (measured on a Windows install:
~14 minutes, up to ~75). So the timer now asks whether the turn is still ALIVE. A transcript that
has not moved for `MEMORY_INFLIGHT_QUIET_MIN` minutes (default 10) is over or abandoned, and its
last exchange is captured exactly as the hook would capture it — stamped `inFlight: true`, and
rewritten in place with the flag cleared if the turn ever resumes and ends.

**And most of the time it does not have to wait at all.** Every assistant record in the transcript
carries `stop_reason`, and `end_turn` (or `stop_sequence`) means the model STOPPED — the same event
the Stop hook fires on. So a timed walk captures that exchange on the very next tick, with no quiet
threshold and no `inFlight` flag, because there is nothing provisional about it. Only a turn whose
last record is `tool_use` (still working) or absent (an older transcript shape) is deferred, and the
quiet rule above is what eventually releases it. Measured with a live server at a 2-second interval:
**1.7 seconds to store**, against three ticks and eleven minutes that never captured it at all.

The same field is why `inFlight: true` now means something. It used to appear on every hook capture
ever made — at Stop time there is by definition no next user turn, which was the only test — so a
flag meant to warn "you may be reading a draft" was permanently on. It is now stamped only when the
transcript itself does not say the turn ended.

**Not every session is a conversation.** A `<scheduled-task …>` transcript is a robot run, and
capture refuses it by design. That refusal is now one shared predicate (`lib/capturable.js`), so the
writer, the walker and `uncapturedSessions` agree about it: such a session is never queued for
capture, never counted as a gap waiting to be filled, and never named in the "captured by the next
timer tick" promise — it is summarised as `excludedSessions: {count, reasons}` beside the count
instead. Before this, four of them sat permanently in a count of eleven and took four of the
walker's eight slots on every tick (measured again while fixing it: 10 uncaptured became 0, all ten
scheduled tasks). `MEMORY_CAPTURE_INCLUDE_TASKS=1` opts them back in.

A few knobs, all optional:

| variable | default | what it does |
|---|---|---|
| `MEMORY_SCHEDULER` | on | `0` switches the in-server timer off entirely |
| `MEMORY_INFLIGHT_QUIET_MIN` | `10` | minutes of silence after which a timed walk stops deferring the in-flight exchange — the fallback for a turn the transcript does NOT say has ended. `0` never defers; `off` restores the pre-1.7.2 behaviour of deferring until a hook runs |
| `MEMORY_SCHEDULER_INTERVAL_SEC` | `300` | how often a walk is wanted |
| `MEMORY_SCHEDULER_TICK_MS` | `60000` | how often the decision is made (one small file read) |
| `MEMORY_SCHEDULER_JITTER_SEC` | random 0–20 | fixed offset per process |
| `MEMORY_CAPTURE_SCRIPT` | derived | the walker to run, if it is not beside the server |

**Several servers is the normal case** — Claude Desktop runs one, and Claude Code runs one per
chat — so the timer is built for it. Every walk takes a lock (`store/.timed-capture.lock`) and
records when it started (`store/.timed-capture-last.json`), whoever launched it. A server whose
neighbour, or the LaunchAgent, walked forty seconds ago simply does not fire; if two do fire
together, one walks and the other exits saying so. The jitter keeps N servers that booted at the
same moment from all reaching the same conclusion in the same millisecond.

The server never writes to the store itself. It spawns the walker, which spawns the same
per-session writer the hook uses, so there is exactly one write path with one lock — see the
header of `lib/scheduler.js`.

---

## Layout

```
index.js                 MCP server entry (stdio; stderr-only logging)
tools/memory.js          the one gateway tool, dispatching on `action`
lib/config.js            paths + THE EMBEDDING CONTRACT + retrieval knobs
lib/corpus.js            frontmatter parse, headings, wikilinks, tier read/write
lib/bm25.js              tokeniser (light stemmer) + Okapi BM25F, 3 field groups
lib/lexical.js           the phrase leg: best window + windowed snippets
lib/embed.js             @xenova loader, chunking/unchunking, query asymmetry
lib/index-store.js       build / validate-header / load .memory-index.json
lib/freshness.js         the staleness guard: stat pass, comparison, inline repair
lib/version.js           which git SHA the running process was spawned from
lib/search.js            fusion, long-doc correction, absence verdict, provenance
lib/secrets.js           the four exclusion mechanisms
secrets-exclude.json     denylist + scrub config + hashed known literals
scripts/build-index.js       npm run index
scripts/verify-stdio.js      npm run verify — raw JSON-RPC, no client needed
scripts/probes.json          the 32-probe benchmark set (queries are verbatim)
scripts/verify-stdio.js      npm test — drives the server over raw stdio
scripts/measure-*.js         where each tuning constant came from
scripts/ingest-transcript.js a conversation becomes exchanges (x-<session>-<ask time>); folds mid-turn
                             messages and subagent reports into the exchange they belong to
scripts/auto-ingest.js       the Stop-hook entry: lock, debounce, run log, staging reindex
lib/scheduler.js         the in-server timer: spawns the walker, writes nothing itself
lib/fs-retry.js          rename-with-retry — a Windows swap fails while anything holds the file
scripts/timed-capture.mjs    npm run capture — walks every active transcript on a timer
scripts/migrate-stable-names.mjs  npm run migrate:names — one-time move off positional names
scripts/audit-store.mjs      npm run audit:store — store vs transcripts (lib/store-audit.js)
lib/store-audit-tick.js  the hourly audit: classify, alarm, self-heal under the capture lock
lib/store-snapshot.js    the daily gzipped-JSONL copy of store/*.md, keep 14
scripts/store-audit-tick.mjs  one audit tick — spawned by the in-server scheduler
scripts/store-restore.mjs     put store files back from a snapshot (missing only, unless --force)
scripts/release-capture.sh   npm run release:capture — the copy the hooks actually run (dist/capture)
scripts/install-capture-hooks.sh  npm run install:capture-hooks — point hooks + LaunchAgent at it
test/run-tests.js        npm test — exit code is the verdict
test/fixtures/projects/  a FIXTURE second project's memory folder (17 hand-written
                         files). Deliberately NOT under ~/.claude/projects, so it can
                         never be mistaken for a real one; reached only by
                         MEMORY_EXTRA_PROJECT_DIRS. It is what made the
                         other-projects routing measurable with one folder on the
                         machine.
```

## What it writes down about you

Local-only, and worth knowing before you point this at anything sensitive.

**Every query is logged verbatim.** `.query-log.jsonl` in the server directory records, per
search: the query text, the scope, the top result's name, the confidence, and whether it refused.
It exists so the retrieval work can be measured against real questions rather than invented ones,
and `npm run analyse-queries` reads it. It is **gitignored**, never leaves the machine, and no
part of it is sent anywhere.

Turn it off with `MEMORY_QUERY_LOG=0`, or point it elsewhere with a path. Nothing else changes if
you do — it is diagnostics, not a dependency.

The other files the server writes beside itself, all gitignored: the index (`.memory-index.json`
and friends), the vector cache, the probe sidecar, and the curation state. All of them mirror
corpus text, which is why none of them is ever committed and why `scripts/commit-memories.js`
refuses to add a remote.

## Known limitations

Measured, reproducible, and not yet fixed. Listed here because finding them yourself and not seeing
them mentioned is worse than reading about them. And one thing that is untested by design rather
than unmeasured: the BM25-only fallback for a model that fails to load at search time — see
[The embedding contract](#the-embedding-contract).

**A long verbatim quote can retrieve worse than a short one.** Quote a sentence from a memory's body
and the memory usually comes back first. Keep adding words from that same sentence and it can drop
out of the results entirely:

| query | rank of the source memory |
|---|---|
| `silently corrupt which is the` | 1 |
| `silently corrupt which is the whole` | not returned |

Why: the keyword leg drops any document scoring below `covFloor × ideal`, where `ideal` assumes the
query's terms at full field weight. Body text carries `fieldWeights.body = 0.3` against `name` 3.0,
so a body-only match sits near 30% of ideal and cannot clear a 60% floor. It is then carried by the
dense and phrase legs alone, and long queries full of common words dilute both.

Lowering that floor was tried and **rejected on measurement** — over 45 verbatim body sentences it
moved nothing (rank-1 25 → 25, missing 18 → 18), so the floor is not the binding constraint. The
same measurement showed the misses concentrate in large documents whose `#section` children compete
with their parent: restricted to whole documents the leg is healthy (rank-1 24 of 28).

**Practical workaround:** quote a *short* distinctive fragment rather than a whole sentence, or use
`latest` with an identifier — that path is a literal term filter and finds body content the ranker
misses, including commit SHAs.

**CR-only line endings (classic Mac) do not parse as frontmatter.** CRLF and a UTF-8 BOM both parse
correctly. A CR-only file is reported honestly (`hasFrontmatter: false`) rather than silently
mis-parsed, but its name, type and headings are lost. Convert such files to LF or CRLF.

## What it costs at size

Measured on one laptop, so treat them as shape rather than benchmark. The fixed cost is the
embedding model (~215 MB resident); everything above that scales with **chunks**, not documents.

| corpus | chunks | index on disk | first build | search p50 | RSS |
|---|---|---|---|---|---|
| 12 notes | 12 | 0.2 MB | ~3 s | ~20 ms | 267 MB |
| 600 notes | 2,440 | 28 MB | ~87 s | 32 ms | 321 MB |
| 2,651 notes | 15,107 | — | — | 101 ms | 968 MB |
| 2,790 notes | 17,815 | 64 MB | ~140 s | ~100 ms | 812 MB |

Three things worth knowing before you point this at something large:

- **Build time follows your biggest file, not your corpus.** 600 ordinary notes index in about
  90 seconds; a single 4.6 MB document takes 163 seconds on its own. If a rebuild is slow, one
  file is usually the reason, and the build now names it.
- **Vectors are `Float32Array` in memory and base64 float32 on disk** (index format v2; `lib/vec.js`
  is the single representation authority). That is 1,536 bytes per 384-dimension vector against
  ~3,700 for the plain JavaScript array this used to keep — measured, not estimated. It costs nothing
  in accuracy: the embedding model emits float32, so float64 stored no extra information, and the
  largest cosine difference between the two over 200 vector pairs is **4.9 × 10⁻⁹**, against the
  10⁻³–10⁻² score gaps that actually decide a rank. **What now dominates resident memory is the
  parsed index itself** — chunk text, names, descriptions and the BM25 postings — not the vectors:
  17,815 chunks hold only ~27 MB of vector data inside an 812 MB process.
- **Search stays fast**: 32 ms at 600 documents, ~100 ms at 2,790. It is the memory, not the
  latency, that will bother you first — the ceiling is your machine's RAM, and one process holding
  the index is what sits in it.

Nothing here is a hard limit; they are the numbers, so you can decide.

## Environment overrides

| var | default |
|---|---|
| `MEMORY_DIR` | the corpus path above (also suppresses project discovery and the handoff roots, so a fixture measures only its own corpus) |
| `MEMORY_CURATED_READ_ONLY` | unset — set to `1` and the server writes **nothing** to your memory folder (see [MEMORY-SAFETY.md](MEMORY-SAFETY.md)) |
| `MEMORY_SNAPSHOTS_PER_FILE` | `5` — previous versions kept in `<memory folder>/.memory-snapshots/` before any frontmatter edit; `0` keeps none |
| `MEMORY_PRUNE_ORPHANS` | unset — set to `0` to stop the capture store pruning its own stale duplicates (never touches your memory folder) |
| `MEMORY_ROOT` | the install directory — point a released copy of the code (`dist/capture/`) at another checkout's data |
| `MEMORY_INDEX` | `./.memory-index.json` |
| `MEMORY_STAGING_INDEX` | `./.staging-index.json` — `0` disables |
| `MEMORY_HANDOFF_INDEX` | `./.handoff-index.json` — `0` disables |
| `MEMORY_HANDOFF_DIRS` | **empty** — opt in with a `:`-separated list of dirs (`;` on Windows) |
| `MEMORY_HANDOFF_DOCS` | `1` — `0` turns the handoff corpus off entirely |
| `MEMORY_PROJECTS_INDEX` | `./.projects-index.json` — `0` disables |
| `MEMORY_ALL_PROJECTS` | `1` — `0` ignores every other project's memory folder |
| `MEMORY_EXTRA_PROJECT_DIRS` | *(none)* — `:`-separated **memory** dirs (`…/<project>/memory`) treated as extra project roots. Explicit, so unlike discovery it is **not** suppressed by `MEMORY_DIR`; this is what makes the second-project path testable with one folder on the machine |
| `MEMORY_PROJECT_CORPUS` | `projects` — `curated` re-runs the blending measurement, `staging` restores the pre-2026-08-20 behaviour |
| `MEMORY_FIRST_BUILD_MAX` | `40` files — a corpus with no index at all is built inline up to this size, and reported stale over it |
| `MEMORY_MODEL_CACHE` | `./.model-cache` |
| `MEMORY_INLINE_REINDEX` | `1` — `0` keeps the staleness check and the stamp, drops the inline rebuild |
| `MEMORY_AUTO_INGEST` | *(unset)* — `0` never captures a session, `always`/`1` always does. Unset means "capture the sessions the connector was on for". **A hook inherits no environment**, so for a permanent setting use `local-config.json` (`autoIngest` / `captureAlways`); this var is for a one-off manual run |
| `MEMORY_INGEST_SINCE_MINUTES` | *(unset)* — limit a capture to the last N minutes. Set for you by `memory({action:"capture", sinceMinutes})`. The window is measured against each exchange's **last activity**, not the moment its question was asked, so a turn that has been running longer than the window is still inside it |
| `MEMORY_INFLIGHT_QUIET_MIN` | `10` — minutes of transcript silence after which a **timed** walk captures the in-flight exchange instead of deferring it (`0` never defers, `off` always does). Only reached when the last assistant record does not carry `stop_reason: end_turn`/`stop_sequence`; a turn that says it stopped is captured on the next tick regardless. The hook never defers, whatever this says |
| `MEMORY_SECRETS_CONFIG` | `./secrets-exclude.json` — point at a different denylist. Used by the self-test so it can supply its own rather than depend on yours |
| `MEMORY_PROBE_RESULTS` | `./.probe-results.json` — the probe sidecar. It is **per install, not per corpus**, so set this per corpus if two corpora share one checkout |
| `MEMORY_FRESHNESS_TTL_MS` | `3000` — how long a corpus stat pass is reused before it is taken again |
| `MEMORY_QUERY_LOG` | `./.query-log.jsonl` — every query, verbatim, for measurement. `0` disables it |
| `MEMORY_CAPTURE_WINDOW_MIN` | `15` — how far back `npm run capture` looks for an active transcript |
| `MEMORY_INGEST_LOG` | `<store>/.ingest-runs.jsonl` — one line per capture run |
| `MEMORY_VEC_ENCODING` | `base64` — how vectors are written to the index. `array` writes the pre-2026-09 shape, for handing an index to an older build |
| `MEMORY_INLINE_REINDEX_MAX` | `8` files — past this, stamp stale instead of rebuilding |
| `MEMORY_INLINE_REINDEX_COOLDOWN_MS` | `60000` after a failed inline rebuild |
| `MEMORY_IMPORT_AUTOINDEX` | `1` — an `import` that wrote files starts the async index job for that corpus and returns `indexJobId`. `0` leaves the documents to the direct store read until someone runs `index` |
| `MEMORY_GIT_REPOS` | *(none)* — `;`/`:`-separated repos for commit + identifier joins. Unset, every git feature below is a no-op |
| `MEMORY_AUTO_VERIFY` | `1` — auto-verifies identifier-shaped tokens in a query; `0` turns it off |
| `MEMORY_IDENT_TIMEOUT_MS` | `1500` — an overrunning `git grep` is UNKNOWN, never reported as absent |
| `MEMORY_INGEST_COMMIT_TAIL_MIN` | `30` — how long after the last exchange a commit still counts as belonging to it |
| `MEMORY_SECTION_DOCS` | `1` — **on.** Splits large sectioned memories into `parent#section` children. `0` disables. See below |
| `MEMORY_SECTION_MIN_BYTES` | `20000` — size floor for splitting |
| `MEMORY_SECTION_MIN_COUNT` | `3` — a document needs this many `##` sections to be worth splitting |
| `MEMORY_SECTION_KEEP_VERSIONS` | `3` — how many newest version-sections keep hot tier; older ones are demoted to archive (still searchable, no boost) |
| `MEMORY_SECTION_DESC_CHARS` | `0` — prose appended to a section's description. **Measured harmful above 0**; kept only so the measurement can be repeated |

### Section documents (`MEMORY_SECTION_DOCS`) — on by default

`project-changelog` is 635 KB of ~40 version entries and `release-build-checklist` is 100 KB
across 21 sections. The useful unit is one section, and `RETRIEVAL.longDoc` penalises a document by
its chunk count, so neither could win a query about its own content.

Large memories (>= 20 KB, >= 3 `##` sections, never exchanges) are indexed as `parent#section`
children; the parent becomes a small navigation stub. Measured against questions registered
**before** any of them was run (`test/section-questions.json`):

| arm | section questions | recall | MRR | artefact-squat |
|---|---|---|---|---|
| off | 0/12 | 9/10 | 0.783 | 0/32 |
| **on** | **7/12** | 9/10 | 0.783 | 0/32 |

Recall, MRR and the max-over-chunks artefact are identical - seven questions that returned nothing
useful now return the exact section. Baseline 0/12 understates it: only 4 of the 12 returned even
the parent document. `npm test` is 512 passed / 2 failed in **both** arms (the same two).

**Three things had to be true, and none was what the plan predicted.** The long-document penalty
was never the constraint - `MEMORY_SECTION_BETA` and `MEMORY_SECTION_WAIVER` barely move the result
across the whole grid. What mattered was:

1. **IDF counts documents, not index rows** (`docFile`, `lib/bm25.js`). 138 changelog sections
   inflated `missingIdf = idfOf(0)`, pushing `orphanShare` over its floor so the absence guard
   withheld a *correct* answer. The scorer and the normaliser must share that basis, or a section
   whose terms concentrate in one file has its keyword score collapse.
2. **A child owns its identity** - its own hash, and only its own heading. Inheriting the parent's
   hash into a file-keyed reuse map handed every child the parent's chunks and crashed the build
   with `RangeError: Invalid string length`; inheriting headings gave each child a claim on all 275.
3. **The stub reproduces nothing.** Headings are already a separately weighted field and each is the
   first line of its own child, so repeating them made an 18 KB keyword magnet that answered
   "what ports are used across all these projects" with the changelog's table of contents.

**Superseded version sections lose their boost.** The changelog is 135 sections at hot tier where
the newest two or three matter operationally. Sections whose heading carries a version are ordered
**arithmetically** and all but the newest `MEMORY_SECTION_KEEP_VERSIONS` are demoted to archive —
searchable, `get`-able, just not boosted (18 hot, 117 archive). A section with **no** version is
left alone: unorderable is not the same as old. The only language rule is a literal `⚠️ STALE`
marker, which is why "Helper scripts — ⚠️ STALE, do not trust" is demoted while "Counts in this
file go stale — VERIFY the count" is not; the second is advice *about* staleness. Nothing here
reads a section and judges it.

**MEMORY.md is never split**, at any size. It is the index — a list of pointers whose parts mean
nothing apart — and it is loaded into context every session.

Changing the setting changes the corpus hash, so the index is detected stale automatically. A full
rebuild is not an inline one, so the first search after switching may report `indexStale` and ask
for `memory({action:"index"})`.
