# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What "notable" means here:** anything that changes what you install, what you run, what a tool
returns, or what a file on disk looks like. Internal refactors are left out. Where a change was made
because something measurably went wrong, the number is given — this project's claims are supposed to
be checkable.

## [1.8.1] — 2026-09-09

### Fixed

- **`.json` was advertised as a supported import format and then refused.** Only one kind of
  JSON could actually be read — a ChatGPT export. Any other JSON file fell past every branch of
  the reader to `unsupported format .json`, so a single `import` response could say, at once:
  `shape: "JSON (read as text — not a recognised export)"`, `skippedUnreadable: "unsupported
  format .json"`, and `supportedFormats: [… ".json" …]`. Plain JSON is now read as text, which is
  what the shape line already claimed. The ChatGPT-export path still runs first and is unchanged.

  Found by importing a plain JSON file into the **published 1.8.0 package**, not into a checkout.

### Added

- A check that **every advertised format is actually readable** (`(fmt)`), because the format list
  and the reader were two places that had to agree and nothing made them. A format refused for a
  *missing converter* — `textutil` is macOS-only, `pdftotext` may not be installed — is a
  different, legitimate refusal and is still allowed. Mutation-tested by restoring the 1.8.0
  behaviour, which the check catches by name.

## [1.8.0] — 2026-09-08

### Added

- **Installable from npm.** `npx -y agentic-recall` is now the whole install. The package was
  marked `private` and had no `bin`, so the only way to start it was to point `node` at a file and
  paste an absolute path into your client config — which is also what the README told you to do.
  The config block is now four lines with one path in it, and that path is your memory folder,
  which the server will never guess for you.
- **`--version`, `-v`, `--help`, `-h`.** Shipping a `bin` makes `agentic-recall --version` the
  first thing anyone runs. It used to be ignored: the process started a full MCP server on a closed
  stdin and exited 0, which at a shell is indistinguishable from working. An unrecognised flag is
  now **refused** with exit 2 rather than absorbed.
- **`~/.agentic-recall` for package installs** (`lib/state-root.js`). Where the server keeps the
  35 MB embedding model, the vector cache and the indexes is now decided in one place instead of
  re-derived in five. A clone still keeps them beside the code. A package install does not, because
  npm's npx cache is disposable: state written there is discarded on eviction, so the model would
  re-download and the corpus re-embed on a schedule nobody controls.

### Fixed

- **The README pointed at a repository that no longer exists.** The rename to `agentic-recall` left
  the old name in both setup commands, the clone URL, the issue-template Discussions link and nine
  CHANGELOG release links. `github.com/dfrancislyondflabc-tech/recall-mcp` returns 404, so anyone
  who followed the install section could not complete it.
- **`secrets-exclude.json` was read from the state root.** It is shipped configuration — the
  redaction rule set the running version was written against — not per-install state. On a package
  install it was therefore absent and the server failed closed at startup. Found by installing the
  actual tarball and driving it over stdio; no unit test would have shown it, because in a checkout
  the two roots are the same directory.

### Changed

- The public suite's "every spawning test cleans up after itself" gate did not recognise
  `execFileSync` as spawning. Its own vacuity control caught the gap.

## [1.7.5] — 2026-09-07

### Fixed — the `scope:'all'` response envelope (MEM-85, MEM-86)

- **MEM-85 — an EMPTY corpus no longer makes a whole response stale.** One `scope:'all'` answer
  measured on a live 1.7.2 Mac: staging had ranked TEN hits from a 2,983-file index built seven
  minutes earlier, curated and handoff were fresh — and the top level read `indexStale: true`,
  `staleFiles: 0`, "There is no index on disk, so nothing here was RANKED from the corpus", because
  `projects`, a corpus that machine has no folder for, was ORed into the verdict and supplied its
  sentence to the top. The reporting caller believed the envelope over the ten results beside it.
  0 corpus files AND no index is now `empty: true` with a one-line note, contributes nothing to the
  top-level verdict, and makes no claim about the others. A corpus with FILES and no index is still
  stale, still says so, and still sets the verdict — with a warning that NAMES it and says the rest
  of the response stands ("[staging] its index is BEHIND the corpus — 1 file(s) changed …; curated
  ranked normally"). Guard: `staleFiles: 0` beside real index timestamps can no longer carry a "no
  index on disk" claim at the top level — it is withheld and says it was.
- **MEM-86 — 56,634 → 26,842 bytes for the same answer, and 17,123 with `brief: true`.** Measured
  on the reporting caller's own query against the same corpora, read-only, before and after; the ten
  ranked rows are 12,426 bytes in both runs, so the difference is the code. Three changes, in payoff
  order: the section that ranked rows carries `resultsRef: 'results'` + `count` instead of a second
  byte-identical copy (the duplicate was 30 % of the response); a section that ranked nothing, in a
  response where another did, keeps three `bestWeak` rows as names and scores and drops its absence
  paragraph — with the wrapper naming every section that happened to, and both kept in full when
  nothing hit anywhere; and what is identical in all four sections, or is a per-corpus diagnostic,
  is said once. Nothing that states what was or was not READ was touched.
- **`brief: true` now works on `search` and `latest`, not just `get`.** A row keeps name, corpus,
  score, snippet, provenance and its timestamp. The ENVELOPE is untouched — `indexStale`,
  `staleWarning`, `recencyVoid`, `recentUnindexed`, `uncapturedSessions`, `captureHealth`,
  `configWarning` and `guidance` all still ship, because a caller asking for fewer bytes has not
  asked to be told less about what was never read. Applied after the query log, so telemetry still
  records what was ranked.
- **The tests that encoded the defect were split, not deleted.** Three assertions demanded
  `indexStale: true` of every index-less section — which is the belief the bad response acted on —
  and now assert the disjunction, EMPTY or STALE, with the wrapper's behaviour for each. Six more
  read a section's `results` directly and go through one resolver that follows the delegation, plus
  a new check that the delegation RESOLVES: same count, same rows as the named scope. New group
  (a98), 50 checks, with a public sibling so the Windows leg runs it. Ranking unchanged: 43 of 46
  gold queries byte-identical, the three that moved walked key by key, `eval:state` identical on
  base and on HEAD.

Found in live use by another chat on 2026-09-07, which saved the raw payload and measured its composition;
verified independently before and after: gold set MRR 0.85 with rows byte-identical, 20 live probes with
`results` byte-identical, a 240-cell honesty matrix (8 corpus states × 5 scope shapes × 2 actions × brief) with
0 findings — the only changes are the intended empty-scope correction, and a corpus that has files but no
index is STILL flagged stale at the top level, by name.

## [1.7.4] — 2026-09-07

### Fixed — Windows console windows popping up on the desktop (MEM-83)

```
### 1.7.4 — Windows: no console windows, and one walker per machine per interval

- **MEM-83 — console windows stop.** On Windows `child_process` allocates a new console for a
  child unless the call passes `windowsHide: true`, and 52 of 68 launch sites did not — including
  the two that fire most: the walker's `spawnSync(auto-ingest)` every tick and auto-ingest's
  `execFileSync(ingest-transcript)` on **every assistant response** via the Stop hook.
  `lib/scheduler.js` had passed the option for months, with a comment saying why, and it did not
  help: hiding a parent does not hide its grandchildren. New `lib/child.js` —
  `spawnHidden` / `spawnSyncHidden` / `execFileHidden` / `execFileSyncHidden` — is now the only way
  this project starts a process; 28 product call sites converted, 30 literals added across the
  public suite, and `spawnOptsForKill()` hides on both platforms. No-op on macOS and Linux.
- **A guard, not a convention.** `npm run audit:windows-hide` (and `(a97)`, 29 checks) fails the
  suite if any call site in `lib/`, `scripts/`, `index.js`, `packaging/`, `tools/` or
  `test/public/` starts a process without the option, or if a product file imports
  `node:child_process` at all. Anchored on the import rather than a call-name regex; negative
  controls for a bare call, an aliased dynamic import and a namespace import; and the sweep asserts
  how many sites it FOUND, because the first draft blanked the import specifier along with every
  other string and reported a green zero.
- **N clients no longer mean N walkers.** Each connected client runs its own server and its own
  scheduler. The parent now claims the walk by stamping it at spawn time, and both ticks re-read
  the stamp between deciding and spawning (`skipped: another server walked Ns ago`). Measured with
  five servers on a 4 s interval: 10 wasted children per 19 walks → 4 per 18. The lock was always
  the mutual exclusion; this is about not paying for it five times.
```

---

Reported from the Windows PC on 2026-09-06 with the root cause and a local patch of the six hot sites; the
owner confirmed the popups stopped after that patch — the one real-machine observation this class allows,
since a controlled reproduction needs a parent with no console at all (a GUI process), which no test runner
can arrange. The proof that ships is therefore static: the checker below, run against 1.7.3, names every
unhidden site; run against this release, it names none.

## [1.7.3] — 2026-09-06

### Fixed — redaction

- **A password said in a sentence was stored in clear (MEM-79).** The deny vocabulary knew `password: x` and
  `password=x` and credential SHAPES; "my password is Hunter2-Xk9!pass" matched none of them and reached the store
  file, the index, `search` snippets and `sessions().title` — the AWS key beside it was redacted. One new rule,
  `password-in-prose`: a trigger word (`password`, `passwd`, `passphrase`, `passcode`, `pin`), a linking word or
  operator, and a value that is quoted, or 8+ characters with a digit or symbol, or 12+ of anything. A plain
  lowercase word after "password is" is never redacted — measured over the author's 2,956 real exchanges, that
  tier scored 0 true hits and 3 false ("provided", "supposed", "extended") and was rejected. The strict rule found
  19 real hits in that store: the incident's own test lines, three Teams meeting passcodes, and a real
  26-character NAS password sitting in clear since July. Controls that stay untouched: "password is required",
  "password reset link", "the password was provided earlier", "PIN is 4 digits".
- **…and the first version of that rule would have stopped the index from ever building.** The secrets guard
  also runs where the index file is written, on JSON-escaped text, and `required\"` ends in a backslash that the
  rule counted as a symbol — the escape was eaten and the serialized index no longer parsed. Caught by the
  retrieval-regression run before it merged (`npm run index` exit 1, reproduced twice). Backslashes, quotes and
  brackets can no longer be part of a value or qualify one; a serialized-index round trip is now a test.
- Retrieval measured before and after on the author's real corpora: gold MRR 0.85 both sides, ranking snapshot
  identical 46/46, 18 of 20 live probes identical and the 19th changed only in the redacted value.

### Fixed — capture

- **A finished turn is remembered on the next tick, not after ten minutes or never (MEM-77).** The
  timer decided "this exchange is still being written" by asking whether a later user message
  existed — which, in a chat you are still having, it never is. So the newest exchange of a live
  conversation was deferred on every pass for ever (measured on Windows: three ticks, eleven
  minutes, invisible), and the Stop hook — the only path that never defers — stamped `inFlight:
  true` on every capture it had ever made, because at Stop time there is by definition no next user
  turn. The transcript had the answer all along: every assistant record carries `stop_reason`, and
  `end_turn` means the model stopped. A turn that says it stopped is now captured at once, unflagged
  and byte-identical to the hook's own capture; only a turn still mid-tool-call is deferred, and the
  10-minute quiet rule remains its fallback. Measured with a live server at a 2-second interval:
  **1.7 seconds to store, against never**.
- **A fact you state in the question is no longer thrown away with its one-word answer (MEM-80).**
  An exchange was skipped whenever the REPLY was under 200 characters — so "Note for the record: the
  token is ZEBRA-6118." / "Noted." was captured by no path at all, and the session was then stamped
  as fully captured. A short reply is now only a reason to skip when the ask is also short, or
  carries no identifier — a ledger id, a sha, a path, a URL, a filename, a number — and never when
  the assistant did not reply at all. Measured over 117 real transcripts: 21 more exchanges out of
  2,949 (+0.71%), one of them the only memory its session has.
- **Sessions that are not conversations no longer masquerade as a backlog (MEM-78).** A
  `<scheduled-task …>` transcript is a robot run and capture refuses it by design — but the refusal
  lived in one script, so the reader counted four of them as "uncaptured, the next tick will get
  them" (false for ever) and the walker spent four of its eight per-tick slots selecting them. One
  shared predicate now answers for the writer, the walker and `uncapturedSessions`: excluded
  sessions are summarised as `excludedSessions` rather than promised, and every refusal in the run
  log names the session it refused. On the author's machine, ten permanently "uncaptured" sessions
  became zero.

### Fixed — setup, import hygiene, and the test harness

```
- **MEM-81** — `configWarning` reached `curated` and `staging` but was dropped by the grouped
  builders for `scope:'all'` and `scope:'everything'` — the one scope its own `effect` text names.
  It now rides all three aggregate returns (`lib/search.js` searchAll ×2, latestAll), and the
  (a75) stamp-invariance contract names it in a second list, `TOP_LEVEL_WHEN_CONFIG_FAULTY`, that
  a new arm exercises by deleting `MEMORY_LIBRARY_DIR` on purpose.
- **MEM-82** — Claude Desktop rewrites `claude_desktop_config.json` from its cached state when it
  quits, so an edit made while it is running is silently discarded; a real machine came back on
  1.6.3 after installing 1.7.2, and 1.7.1 never went live there for the same reason. SETUP.html,
  the launcher's console output, the generated `START-HERE.txt` and the README now state the
  order — quit, edit, launch, verify `serverVersion` — in red at the config step, on both
  platforms, and setup warns by name when Claude Desktop is in the process list.
- **MEM-76** — every `.zip` import left its extraction in TEMP for ever: a cleartext copy of the
  whole archive, one directory per import, and five from the shipped suite before a user imported
  anything. The extraction is now removed in a `finally` (so a refused archive cleans up too),
  with the Windows retry, and a zip item's recorded `sourcePath` names `<archive>!<entry>` instead
  of a directory that no longer exists.
- **MEM-74** — `npm run test:fuzz` passed each hostile payload as an argv element, so on Windows
  the 200 KB case exceeded the 32,767-character command-line cap, spawned nothing, and was
  recorded as 13 product findings — with the run still exiting 0. The payload now travels in a
  file, a spawn that never ran is reported as a HARNESS failure and exits non-zero, product
  findings exit non-zero, and the child validates against the registered zod shape as well as
  calling the handler, so the 8,192-character `query` bound is exercised the way a real client
  exercises it.
- **MEM-75** — nine of `campaign-lite`'s eleven KNOWN markers named fixes that shipped in 1.7.1
  and 1.7.2, so each was masking a future regression rather than a present defect; they are strict
  now. Of the two that still fired, one was a defect in the test itself (the query-log scan counted
  the block's own token probes as a canary leak; it now reads only `src:'canary'` rows) and the
  other is MEM-79, not MEM-43 — a bare password typed as the query has no shape to redact.
```

## [1.7.2] — 2026-09-05

The first Windows PC run of 1.7.1 and two late campaign blocks (upgrade in place; import → searchable)
found nothing wrong with the engine and seven things wrong around it: the setup page hid a user's real
memories, the last exchange of a chat waited for the hourly audit, the shipped test suite crashed in
its own cleanup on Windows, the zips carried an install guide that was false in every line, an
in-place upgrade kept the old config, the scrubber ate delimiters, and `capture` had reported 0 on
every call ever made. All fixed here, each with a test that goes red without it.

### Fixed — install and packaging

- **MEM-66 — setup pointed `MEMORY_DIR` at the bundled seed on machines that already had memories.**
  `packaging/setup-page.mjs` now resolves the memory folder in precedence order: an explicit
  `MEMORY_DIR` (or `local-config.json`'s `memoryDir`), then the discovery `lib/config.js` already
  performs over `~/.claude/projects/*/memory` (most-populated first, ≥ 1 `.md`), then the bundled
  seed — and SETUP.html, the launcher window and `START-HERE.txt` all say which was chosen and how
  to change it. Found on the Windows PC, where a user following the page verbatim got a corpus that
  could not see one of their 400 memories.
- **MEM-68 — three things an in-place upgrade left behind.** (1) An upgraded install keeps the 1.7.0
  config (`MEMORY_DIR` without `MEMORY_LIBRARY_DIR`), the MEM-32 trap the 1.7.1 setup page closes:
  the server now logs one line at boot and stamps `configWarning` on responses (carried by
  `SECTION_KEYS` and the compact everything view). (2) `lib/search.js` no longer imports
  `lib/ordinary-shadow.js` at all — the lazy import let a leftover 1.7.0 copy on disk undo the
  distribution exclusion and write query-bearing telemetry a fresh install does not. (3)
  `test/sandbox-env.js` now ships, so an upgrade overwrites the stale copy; syncing it exposed that
  the shipped suite's own inlined copy of that list was three keys short.
- **MEM-70 — the zips shipped an install guide that was false in every line.** `dist/setup.cmd`,
  `dist/setup.sh` and the three `dist/*.md` install docs are gone. Both launchers now sit at the
  root of the plain zip as well as the portable one and fall back to an installed Node, and one
  generated `START-HERE.txt` — covering the memory folder, verification, the optional hook and what
  an upgrade must re-do — is the only install document. A release check asserts no shipped document
  tells a zip recipient to run the package manager's install step — a phrase this changelog
  itself must now avoid, since it ships.
- **Optional: capture the last exchange of a chat as it ends.** `node packaging/install-hooks.mjs`
  adds this install's `Stop`/`SessionEnd` capture hooks to Claude Code's `settings.json` — backing
  it up first, touching no other hook, doing nothing on a second run, refusing when another install
  is already wired in, and reversing with `--uninstall`. Setup shows the command and never runs it.

### Fixed — capture

- **The last exchange of a chat no longer waits for the hourly audit (MEM-67).** A timed capture
  defers the exchange still being written — right while the turn is live, wrong once the chat is
  over — and the Stop hook, the only path that never defers, is not installed on a connector-only
  install. Worse, the walker stopped selecting the session at all: a deferring run stamps the whole
  file it read, and an abandoned transcript never grows again. Now a transcript quiet for
  `MEMORY_INFLIGHT_QUIET_MIN` minutes (default 10) is treated as over, its last exchange is captured
  exactly as the hook would capture it (`inFlight: true`, rewritten in place when the turn resumes),
  and a deferral is recorded on the stamp so the walker keeps coming back. Measured with a live
  server at a 2 s interval: **1.2 s to store, against never** (previously ~14 min in the field, ~75
  min worst case). New public check `inflight-quiet-capture-e2e.mjs` runs it on windows-latest.
- **`capture` now says what it did (MEM-71).** `exchangesCaptured` was read from a line the capture
  run does not print, so it was 0 on every capture ever made. It is now computed from the run
  itself, and a refresh of the exchange you are in the middle of is reported as
  `exchangesRefreshed` rather than as "nothing happened".
- **`sinceMinutes` follows the conversation, not the clock at the top of it.** The window is applied
  to each exchange's last activity, so a turn that has been running for 45 minutes is still inside
  `sinceMinutes: 30`. It can only admit more than before, never fewer.

### Fixed — the shipped suite and the scrubber

- **MEM-69 — the shipped public suite crashed in its own cleanup on Windows.** A recipient
  running `node test\public\run-public-tests.js` from the 1.7.1 zip got a stack trace and exit 1
  after 130/130 checks had passed: `fresh-install-e2e.mjs` stopped its server with `child.kill()`
  — which on Windows neither reaches the scheduler's capture grandchildren nor waits for the
  exit — and then removed the sandbox a line later, which Windows refuses while a handle is open.
  32 checks never ran there, three runs out of three. Every public test now stops children with
  `killTree` + an awaited exit and removes its sandbox through a retrying helper that **logs and
  continues** on failure: cleanup is never an assertion. `run-public-tests.js` asserts the
  convention structurally over the files themselves, with a negative control built from the
  pre-fix code — the missing import is exactly how this happened. Two files were also silently
  leaking their sandbox on every run. `test:full` 162 → 173 checks, zero temp dirs left behind.

- **MEM-65 — a redaction ate the quote around the secret.** `token-assignment` matched the
  OPENING quote of a string literal and its replacement never re-emitted it, so
  `const TOKEN = 'pubtok-…';` scrubbed to `const TOKEN=[REDACTED:token-shaped]';`. That is how
  the public suite shipped **unparseable** in the 1.7.0 and 1.7.1 portable zips (MEM-64, patched
  then with an exemption). All 20 patterns in the deny vocabulary were audited against the same
  property; `password-colon` and `passwd-colon` were swallowing **both** quotes, which is just as
  fatal in code and mangles a scrubbed memory export in prose. All three capture their delimiters
  and re-emit them now, and the marker lookahead moved after the quote group so a rule cannot
  re-fire on its own quoted output. New `(a92)`: a round-trip property over every pattern
  (delimiter counts in == out, minus the secret), idempotence, and a whole-tree gate that
  redacts every shipped `.js`/`.mjs` and requires the result to parse — with the 1.7.1 pattern
  applied to the real shipped file as the negative control. The MEM-64 exemption stays, for its
  original reason (these files are leak fixtures; scrubbing them inverts their assertions) and no
  longer for syntax — which `(a92)` now proves rather than asserts.

### Fixed — import

- **An import now builds the index it just changed (MEM-72).** An `import` that wrote at
  least one file starts the async index job for that corpus and returns `indexJobId` +
  `indexScope`; the response says the documents are served from the store, not ranked,
  until `index_status` reports the job done. Measured over eight import shapes twice,
  every imported document had previously stayed unindexed indefinitely: the 5-minute
  walker reconciles staging only, and the inline rebuild refuses anything past 8 changed
  files. Nothing blocks — a 3-file import that started a build returned in 42 ms. A dry
  run starts nothing, an import that wrote nothing starts nothing, and a build already
  running for that corpus is JOINED (`indexAlreadyRunning: true`) rather than raced.
  `MEMORY_IMPORT_AUTOINDEX=0` switches it off; the direct store read still answers.
- **`.zip` imports on Windows, and the converter report stops lying there (MEM-73).** The
  probe ran `command -v` through `shell: '/bin/bash'`, which does not exist on Windows —
  so every converter read as missing whatever was installed and `.zip` import was refused
  outright, losing two of the eight supported import shapes on that platform. The probe is
  now `where`/`which` spawned with no shell, and archives are read in-process by the new
  `lib/zip.js` (`node:zlib`), so no external binary is involved at all. A stored symlink is
  still restored and still refused when it points outside the archive, and an entry name
  that climbs out of the destination is now refused by name — a guard `unzip` used to
  perform. `converterReport()` reports the platform and the probe it used.
- **The public zip check no longer excuses itself on Windows.** Its fixture was built by
  the `zip` binary, absent on `windows-latest`, so the check recorded a PASS there without
  running — on every Windows run of the release that shipped the bug above. The fixture is
  written in Node now, and a second pass imports the same archive with an empty `PATH`.

## [1.7.1] — 2026-09-05

Capture had two triggers and both of them were somebody else's job. The `Stop` hook fires when a
turn ends, so a chat left open all afternoon was captured never. The five-minute walk that closes
that gap came from a **macOS LaunchAgent** — a `.plist`, installed by hand — so **on Windows it
never ran at all**, and every sleep/wake and long-session gap `scripts/timed-capture.mjs` was
written to close was open the whole time on that platform.

This release moves the clock into the one process that is already loaded whenever memory matters.
The server is a **scheduler, not a writer**: it spawns the same walker, which spawns the same
per-session writer, so there is still exactly one write path with one lock. What is new is that
switching the connector on is now sufficient, on every platform, with nothing else installed.

Proved where it matters: the end-to-end check starts a real `node index.js` over stdio, waits, and
asserts the exchange reached the store, the index and a `latest` answer — and it runs on
**windows-latest** in CI, alongside ubuntu and macos.

### Added

- **An in-server capture scheduler** (`lib/scheduler.js`, started from `index.js` beside the
  heartbeat). Every `MEMORY_SCHEDULER_TICK_MS` (60 s) it reads one small file and decides; every
  `MEMORY_SCHEDULER_INTERVAL_SEC` (300 s) it spawns a walk, `detached` + `stdio: 'ignore'` +
  `windowsHide` + `unref()`, never awaited and never able to throw into its host. The tick timer is
  `unref()`d, so the server still exits the instant Claude closes the transport. Kill switch
  `MEMORY_SCHEDULER=0`. The decision is a pure exported `shouldSpawn()`, driven as a truth table by
  the suite rather than by waiting five minutes for a timer.
- **A walker lock and a walker stamp** — `store/.timed-capture.lock` (`wx` + pid liveness, the same
  pattern `auto-ingest.js` uses) and `store/.timed-capture-last.json` (`{at, pid, source}`, written
  at START). **Five things can now fire a walk on one machine**: Claude Desktop's server, one server
  per Claude Code chat (four were live here on 2026-09-04), and the LaunchAgent. Five walks is not
  five times the capture — it is five processes each spawning up to eight ingests that then lose a
  race and exit having spent a node spawn on nothing. A second walker logs
  `skipped: walker lock held` and exits 0; a server whose neighbour walked forty seconds ago never
  starts one. Per-process jitter (0–20 s, scaled down for short intervals) keeps servers that booted
  together from deciding in the same millisecond.
- **The walk appears in the run log** as `trigger: "walker"` rows (`started` / `finished` /
  `skipped`), so a walk and the ingests it spawned read as one story. `lib/ingest-health.js`
  deliberately ignores them: the walker writes nothing, so a walk killed by a sleeping laptop cannot
  have left the store and the index disagreeing, and counting it as a crashed writer would force a
  redundant reconcile and stamp `captureHealth: unhealthy` onto every read afterwards.

### Fixed — Windows

Each of these was silent. None of them failed a test; they changed what the code did on one platform
and said nothing.

- **`os.homedir()` is `USERPROFILE` on Windows, not `HOME`** — and the public suite's sandbox set
  only `HOME`. Every child that discovers `~/.claude/projects` through `homedir()` was therefore
  reading the **runner's real profile** on `windows-latest`, so the Windows leg of the suite was
  quietly exercising a different code path from the other two. Both variables are set now.
- **`process.kill(-pid, 'SIGKILL')` is a POSIX process group and throws on Windows**, so the fault
  injection in both recall-stress harnesses never fired there: the run completed normally and was
  observed as a fault that did not arm. Replaced by one shared `killTree()`
  (`test/public/kill-tree.mjs`) using `taskkill /PID <pid> /T /F` — the **tree**, because the walker
  spawns `auto-ingest`, which spawns `ingest-transcript`, and killing only the parent leaves the
  extractor writing into the store after the test believes it is dead. `detached: true` is also
  dropped on Windows, where it opens a console window and isolates nothing.
- **`renameSync` over an open file fails on Windows** (`EPERM`/`EBUSY`/`EACCES` from MoveFileEx)
  where POSIX rename cannot. Three renames in the capture path are the last step of a
  write-temp-then-swap, and the worst of them is the store write in `ingest-transcript.js`: the
  failure removed the temp file and propagated, so on the one platform where nothing else would ever
  retry it, **the exchange was lost and the ingest marked failed**. All three now go through
  `renameWithRetry()` (`lib/fs-retry.js`) — one retry after 50 ms for a sharing violation only;
  `ENOENT` still throws immediately.
- **`scripts/timed-capture.mjs` was the only reader that ignored `MEMORY_TRANSCRIPT_DIR`.**
  `auto-ingest.js` and `lib/capture-status.js` both honour it, so the writer, the reader and the
  *selector* could each be looking at a different set of conversations — and the walk was the one
  part of capture that could not be pointed at a fixture.

### Fixed — packaging

- **`build-zip.sh` said "verified: no personal content" without ever running the release gate**,
  which refused the tree it was zipping — 34 files, including a colleague's address and 33 of the
  author's own memories under `test/fixtures/`. `clean` and `portable` now exclude those paths and
  RUN `check-release-clean.mjs`, refusing to produce a zip that fails it; `mine` announces itself as
  a personal zip.
- The `clean`/`portable` zips carried no `.build-stamp.json`, so an installed copy reported
  `sha: null`. Every mode writes one, and the build verifies the unpacked tree reports it.
- The generated setup snippet set `MEMORY_DIR` without `MEMORY_LIBRARY_DIR`, silently switching the
  library corpus off on every fresh install; `import` with a category then reported `ok: true` for
  documents that could never be searched (MEM-32). The snippet sets both, and `import` refuses —
  naming the variable — when the library corpus is unreachable.
- `scripts/score-currency.js` built a file URL as `'file://' + path` (the 1.6.3 bug class), a silent
  no-op on Windows. `pathToFileURL` everywhere.

### Fixed — `import`

- **An unknown argument was silently dropped, so a `dryRun` typo imported for real.** The SDK wraps
  the tool's shape in a plain `z.object()`, which strips unknown keys before the handler runs — the one
  flag whose purpose is "do not write" was simply absent. The registered schema is now re-parsed
  `.passthrough()` so the key reaches the handler, and the write actions (`import`, `capture`,
  `index`, `demote`, `promote`) refuse it by name with a did-you-mean and the accepted list. Read
  actions stay tolerant: a stray key on `search` costs nothing, one on `import` costs files on disk.
- **A dry run said `written: 3` for three files that did not exist.** It now reports `written: 0`,
  `wouldWrite` / `wouldWriteNames`, and `wouldReplace` for a supersede that did not happen; skip
  counters still populate, and the MEM-32 refusal (category with no library dir) still fires.

### The hourly store audit — the one honesty channel a lying stamp cannot fool (MEM-50)

- **`lib/store-audit-tick.js` + `scripts/store-audit-tick.mjs`** — the loaded server spawns a
  transcript-vs-store audit every hour (`MEMORY_STORE_AUDIT_MIN`, `0` = off; first one 5 minutes after
  boot). MEM-39 lost six exchanges to a debounce stamp that lied, and all three existing freshness
  channels reported health throughout, because each of them trusts the stamp, the run log or the
  index. This one re-runs the real extractor and diffs filenames; it reads the stamp never.
  A `missing` exchange younger than 15 minutes is the in-flight one and is normal; older is an alarm,
  and the tick repairs it under the capture lock and rebuilds the staging index. Measured: 20 sessions
  of a 2,921-file store in 6.8 s wall / 4.7 s CPU, and the audit path loads no embedding model
  (proved with an ESM resolve hook: 15 specifiers, none of them the embedder).
- **`lib/store-audit.js` could not see the state it exists to detect** — it listed sessions from the
  STORE, so a session whose files are *all* gone was invisible. It now also audits sessions the
  debounce stamp CLAIMS were captured and that have no file at all: the stamp is read to enumerate
  claims, not to be believed.
- **`captureHealth` now carries two channels that were write-only** — the last `.vanish-report.jsonl`
  row (indexed documents that disappeared from disk; nothing had ever read it) and the audit's
  verdict, with `status: 'unhealthy' | 'degraded'`. No read-path change was needed: `captureHealth`
  already rides whole through `SECTION_KEYS` and `EV_GROUP_KEEP`.
- **A daily store snapshot** — `store/.snapshots/store-YYYY-MM-DD.jsonl.gz`, gzipped JSONL, keep 14,
  skipped on a day the store has not changed (2,921 files / 19.2 MB → 6.7 MB, 5.4 s).
  `scripts/store-restore.mjs` puts files back — **missing only** unless `--force`, because the reason
  to run it is that something deleted files and overwriting the survivors turns a partial loss into a
  total one. It exists because Claude Code prunes transcripts after 30 days, after which the store is
  the only copy.

### Fixed — security (campaign B)

Four leaks and three hygiene defects, each reproduced twice with invented secrets, each with a test that
goes red without the fix and a control that proves the test is not vacuous.

- **A private key's body survived every scrub.** The redaction pattern matched only the
  `-----BEGIN … PRIVATE KEY-----` header; the key itself reached the store, both indexes, `get` and a
  `latest` snippet. The pattern now covers the whole block, and the fixture that let this hide (a
  header alone) has a full-block sibling.
- **A secret typed as a query reached the query log in plaintext** through `latest` and `thread`,
  which logged before redaction (`search` logged after — the control). Redaction now happens inside
  the log writer, so call order can never matter again.
- **The canary probe could pick a token out of an excluded file** (a denylisted name or
  `metadata.secret`) and write it to its own log. It now applies the same exclusion the indexer does.
- **`sessionTitle` was written unredacted** while the description from the same ask was scrubbed; a
  foreign address's identity reached `sessions().title`. One scrub helper now serves both.
- **The older stale-file warnings named denylisted and secret-marked files** ("appears in
  `…credentials.md`") and told the reader to open them. Excluded files are filtered before anything
  is named.
- **A changed store file was returned and counted twice** by `latest` and `sessions` — its indexed
  old version and its direct-read new version. The direct read now replaces the indexed row.
- **A 1 MB query produced an 8.8 MB response** (×8.44 measured on 1.7.1). The `query` argument is bounded (8 KB), term count is
  capped, and the response echoes at most 512 chars of it.
- `_archiveSuperseded` wrote under `MEMORY_CURATED_READ_ONLY=1`; it now goes through the guarded door.

### Fixed — found by the Mac big test (test-G)

Nine agents tested 1.7.0 and the 1.7.1 candidate on macOS and, through GitHub Actions, on Windows and
Linux; these are the defects that had to be fixed before 1.7.1 could leave the machine. Each one was
reproduced twice, named in the ledger, and now has a test that goes red without the fix.

- **A test fixture was destroying real captures.** The suite's `capture` fixture ran against the real
  store and stamped the live transcript's debounce marker at its full size, so the next real capture
  saw "nothing new" and skipped — six of six exchanges lost in the reproduction. The public
  `verify-stdio` check did the same on every fresh install. Both now run only in a sandbox, a windowed
  or no-write run no longer stamps a size it did not process, and an end-of-suite guard fails the
  suite if `.last-ingest.json` changed while it ran.
- **The crash-repair never ran when no conversation was active.** The walker printed "forcing a
  reconcile pass" and then exited early because nothing was selected for capture — exactly the shape
  of the incident that started this work. The reconcile and the canary observation now run
  regardless of the selection.
- **The harness's four mutations were inert** (patch drift; two marked unrunnable after their
  prerequisites shipped; an `env` field nobody read), so "18/18 green" had no working negative
  controls. Regenerated against 1.7.1, all four red exactly where predicted; scenario S18 is gated now
  that MEM-27 is fixed.
- **The ranking-snapshot gate was red and therefore unenforced**: its sandbox leaked the author's real
  transcript list into 11 of 46 responses, and the gold file predated 1.7.0's additive `indexStale`.
  Sandbox fixed, gold regenerated after confirming the only diffs were the intended keys; `--compare`
  exits 0.

### Fixed — found by the reliability soak (campaign A)

- **A fresh install never recalled anything for the life of the process.** A server that started
  before its first staging index existed adopted a newer on-disk index only when it already had one
  loaded; with nothing loaded the branch never ran, so it kept answering "no index on disk" while a
  complete index sat beside it — 0 rows in the same process, 1 row in a fresh one. It now adopts
  whenever the disk has a build the process lacks, and the public end-to-end test asserts the row
  comes from the index in the same process that booted without one.
- **The same "no index" state never armed the direct read**, so the store-is-truth safety net was
  inert exactly where the index helped least. The no-index branch now scans the store and serves
  unindexed files directly, and says so.
- **`uncapturedSessions` went quiet about a session that grew inside its 60-second memo**, naming
  other sessions as behind while omitting yours — the dominant dishonest verdict in the soak. The memo
  is now invalidated by growth and bounded by `MEMORY_CAPTURE_STATUS_TTL_MS` (default 5 s).
- **With `MEMORY_ROOT` set, the server introduced itself as version 0.0.0** and stamped every response
  `@unknown-sha` because it read `package.json` from the data root. Version, sha and build stamp now
  come from the code root.
- The recall-stress oracle could not read the shipped `uncapturedSessions` shape and classified honest
  responses as dishonest (test-only).

### Fixed — robustness (campaign C)

- **A truncated index is no longer believed.** `indexHeaderOnDisk` read only the first 4 KB, and the
  header is at the START of the file — so an index truncated to 60 % of its bytes reported a valid
  docCount and a matching source-listing digest, the reconcile logged "index agrees with the store,
  untouched", and the corpus answered zero rows permanently. The header readers now prove the file
  is whole first (a 64-byte tail read, plus a size floor on indexes of 100+ documents); a file that
  cannot be shown whole reads as "cannot tell", which every caller already treats as "rebuild".
  `loadIndex` says "exists but is unreadable (truncated)" instead of "no index file". (MEM-51)
- **A per-document chunk cap, `MEMORY_MAX_CHUNKS_PER_DOC` (default 200).** One 6 MB exchange in a
  five-file store was 5,357 chunks and a 244 s rebuild — longer than the 300 s capture tick.
  Measured against the real corpora (p99 46 chunks over 2,921 staging documents, max 121; p99 24
  over 420 curated, max 88), the cap is 4.3x the largest document that exists and touches nothing;
  a document that hits it keeps its head chunks, stays findable, and carries
  `chunksTruncated: {kept, total}`. (MEM-52)
- **A corrupt index now repairs itself.** An unparseable index read as "never indexed", so the
  first-build bound (40 files) refused to rebuild it — and nothing else ever did, because the
  ingest reconcile owns the staging corpus only. A corrupt index over the bound now triggers a
  background rebuild while the query is answered honestly and immediately (measured: a 56-file
  corpus is whole again 2 s later; an inline rebuild of the real 420-document curated corpus would
  have blocked the query for 2.9-3.2 s warm, 90-110 s cold). Kill switch
  `MEMORY_CORRUPT_INDEX_REPAIR=0`. (MEM-59)
- **An empty file in a corpus is skipped and named**, instead of becoming a zero-chunk document
  that inflated `docCount` and the recall canary's arithmetic while nothing mentioned it. The index
  header carries `skipped: {empty, names}` when it happened. (MEM-56)

### Fixed — robustness, second pass (campaign C)

- **A clock that moved backwards no longer stops capture.** A `.last-ingest.json` debounce stamp
  written ahead of the system clock (a timezone fix, an NTP correction, a VM resume, a dual-boot
  RTC) made the elapsed time negative, and a negative number is always under the 600-second
  debounce — so `auto-ingest` skipped before it took the lock, and both the capture and the
  store-vs-index reconcile it carries stopped for that transcript until the clock caught up.
  A stamp from the future is now read as "no run has been recorded", the same rule the walker
  scheduler already applied. Measured: a store file that landed after the last build went from
  permanently unindexed to indexed on the next run. (MEM-53)
- **…and no longer defers the reconcile either.** The same negative-age bug in `reconcileAllowed`
  deferred every store-vs-index rebuild for the length of the offset, and the "the corpus grew"
  escape hatch could not cover it because an *edited* memory changes the digest without changing the
  file count. An edited memory is now re-indexed on the next tick regardless of the stamp.
  (MEM-54)
- **The half-written file a killed writer leaves in the store is now swept, and named.** An exchange
  write that is interrupted between its temp file and the rename left `<name>.md.<pid>.tmp` behind
  for ever: invisible to retrieval, but unbounded disk growth that no channel mentioned.
  `auto-ingest` now removes such a temp when its owning process is gone or it is over ten minutes
  old (`MEMORY_STORE_TMP_MAX_AGE_MS`) and logs `swept`; a live writer's temp is left alone. The store
  audit reports the same files as `orphan-temp`, so a machine where capture has stopped — which is
  exactly where the sweep is not running — still says so. (MEM-55)
- **The scheduler's two state stamps are written atomically.** `.timed-capture-last.json` and the
  audit stamp were the last files written with a plain truncating write, which leaves a zero-byte
  window a concurrent reader can land in — measured at 8 % of reads under a writer/reader race, and
  seen once in five kill tests. Both now write to a temp file and rename. They always failed safe
  (an unreadable stamp reads as "due"), so this is the invariant rather than a visible bug.
  (MEM-57)

### Fixed — the walk period, the latched health flag, the read-only store (campaign A, final)

- **The capture walk now happens every 300 s, not every 360 s (MEM-60).** The scheduler measured
  the interval against a stamp written by the walker *child*, tens of milliseconds after the tick
  that spawned it — so with the interval an exact multiple of the 60 s tick, the tick at 300 s was
  always a few ms short and the walk slipped to 360 s. Jitter (0–20 s, added to the due point) made
  that deterministic in 20 boots out of 21. Measured over an hour: 360.0 s in 10 of 11 gaps, and
  120 s where 60 s was configured. The scheduler now keeps its own spawn time (the on-disk stamp
  stays as the cross-process signal and the restart fallback) and treats a due point falling inside
  the coming tick as due now, so the observed period is the configured interval ± half a tick. The
  whole 5-minute budget used to be spent before capture began; it now isn't.

- **`captureHealth` no longer reports a crash that has already been repaired (MEM-61).** A killed
  capture run left a `started` row that nothing could ever close, because the repair is logged by
  the *recovering* run under its own pid. One soak measured 669 responses still stamped `unhealthy`
  37.6 minutes after the reconcile that fixed it — and a warning that is always on is a warning
  nobody reads. A crash is now closed by a later `crash-recovered`, `reconciled` or `captured` row
  from any process, or by a walk whose reconcile pass compared the store to the index. A quiet
  tick, a debounced reconcile, and a repair that happened *before* the crash still close nothing.

- **A store that cannot be written now says so, instead of blaming a dead walker (MEM-62).** With
  the store read-only, capture logged `skipped: walker lock held by pid <n>` — naming a process that
  had been dead for six minutes — and exited 0, because every error from the lock's `wx` create was
  read as "somebody else holds it". EEXIST is now the only errno that means held; EACCES, EROFS,
  EPERM, ENOSPC and ENOENT are reported as `failed` with the errno and the path, on stderr when the
  run log is in the same unwritable directory, and the walker exits non-zero. Nothing was ever lost
  to this — it is what a human sees when they ask why capture stopped.

### Tests — Windows gets the same depth as the Mac

- **The full recall-stress harness now runs on Windows, it found that six of its scenarios were
  decorative there, and that is fixed.** `.github/workflows/stress-windows.yml` runs all 18
  scenarios on `windows-latest` and `macos-latest` (on `release-*`/`main` pushes and on demand — Windows only on push; the macOS control leg is a dispatch option, because macOS minutes bill at 10× on a private repo and the first day of this workflow exhausted the account's allowance)
  instead of the 3-scenario lite subset the public suite carries. The first run: 18/18 pass and
  `6 injections, 6 needed a retry, 6 UNARMED`. `verifyFault` proved a kill had landed by asking for
  `signal === 'SIGKILL'` — and **Windows has no signals**, so `taskkill /T /F` leaves
  `{code: 1, signal: null}` and the clause was false on every attempt whether or not the kill
  worked. The kill had worked every time: `ci-helpers/kill-tree-probe.mjs` measured the
  grandchild's heartbeat freezing 63 ms after it. S2/S3/S4/S5/S6/S18 — every crash-recovery
  scenario there is — were vacuous on the platform they were most needed on. (MEM-63)
- **The proof of a kill is now the evidence the platform actually produces.** `killTreeMarked`
  records, at the instant of the kill, which pids `taskkill` named as terminated and whether they
  are gone a moment later. On win32 the verifier reads that marker and never consults `signal`; on
  POSIX `signal === 'SIGKILL'` still stands and the marker is accepted alongside it, so both
  platforms share one shape. `gone` is deliberately NOT required on POSIX — a SIGKILLed child is a
  zombie until reaped and `process.kill(pid, 0)` succeeds on one (measured on darwin). The landing
  site and the run log's started-without-terminal signature stay mandatory on both, and that
  signature must now be **new to this attempt**: `crashedRuns` scans the whole log, so a retried
  fault could complete cleanly and inherit the previous attempt's crash — a fault that did not fire,
  verified as one that did.
- **`taskkill` names two pids per line and only the first one died.** Each `SUCCESS: The process
  with PID 4884 (child process of PID 6512) has been terminated.` line carries the casualty **and
  its parent** — and for the root of the tree that parent is the harness itself. A `/PID (\d+)/g`
  over the whole output put our own live pid in the casualty list, `treeGone` found it running, and
  every fault would have reported "a pid outlived the kill": MEM-63 one turn further on, with the
  failure moved from the signal clause to the pid list. The parse is per line, anchored on
  `with PID`. Also: a `tasklist` that could not RUN used to answer "not alive", turning "I cannot
  see it" into "it is dead" — it now fails closed; and the gone-poll naps 100 ms between polls
  instead of spawning `tasklist` in a tight loop.
- **The job asserts `ARMED 6/6` by value, on every platform.** It used to `grep` for
  `', 0 UNARMED$'` — which a run that injected **zero** faults also satisfies, by printing no such
  line at all, and which in a scroll-back reads exactly like the good outcome. `run.mjs` now emits
  `  ARMED n/m` unconditionally (`0/0` included) and raises a hard failure when a run with no
  `--only` filter injected nothing. There is no Windows exemption left: an unarmed fault fails the
  job wherever it happens.
- **Both platform branches of the kill rule are unit-tested from whichever machine runs the
  suite** (`test/run-tests.js` (a89), 27 checks). `killProof` and `verifyFault` both take
  `isWindows` as a parameter, so the recorded win32 exit shape — `{code: 1, signal: null}` plus the
  marker — is asserted ARMED, the same shape under the POSIX rule is asserted UNARMED (that being
  the six-scenario failure itself), and a kill this harness never issued is UNARMED on both. The
  `taskkill` output parse is a pure function fed a recorded transcript, with a control asserting
  that the naive regex would have listed six pids where three died. **A rule that can only be
  tested where it already works is how the first one went wrong unnoticed.**
- **The two mutation steps had never actually run.** Both patches were inert on `release-1.7.1`
  until `wp-bigtest-fixes` regenerated them, so nobody had contradicted their `--expect-red`
  arguments — and both were wrong. The flags are dropped; `run.mjs` compares against the committed
  table in `scenarios.mjs` in **both directions**, which is an expectation that can rot loudly
  rather than one the workflow asserts to itself.

### Fixed — the zip itself

- **The release scrubber was breaking the test suite it shipped — in 1.7.0 too.** The `token-assignment`
  redaction consumed the opening quote of a string literal and never re-emitted it, so
  `const TOKEN = 'pubtok-…';` shipped as `const TOKEN=[REDACTED:token-shaped]';` and
  `node test/public/run-public-tests.js` from an unzipped install died on a `SyntaxError` before running
  one check. Nobody had ever run the public suite from a zip — only from a git checkout, where it was
  green. The two shipped test files are exempt from that rule (the hash route still applies), and the
  build now parse-checks every shipped `.js`/`.mjs` after the scrub and refuses the zip if one does not
  compile (exit 8; a planted broken file is refused with no zip written). From this zip the suite runs:
  162 passed, 0 failed. (MEM-64; the pattern itself is MEM-65, below.)

### Not in this release — what a reader taking over should know is still open

- **MEM-58** — the vector-cache checkpoint `JSON.stringify`s the whole cache every 50 embedded documents
  (O(n²) bytes, ~1.6 GB over a 5,000-document build) for a measured ≤ 9 % of wall clock. 1.7.2.
- **MEM-65** — the `token-assignment` scrub pattern still eats the opening quote; shipped CODE is now
  gated (MEM-64) but a scrubbed MEMORY export can carry a malformed document. 1.7.2.
- **Windows proof of the final code on GitHub runners is PENDING**: the account's Actions minutes were
  exhausted on release day (this release's own CI, mostly macOS at 10×), so `portable-windows` /
  `portable-macos` on the 1.7.1 zip and `stress-windows` with faults armed have not run on
  `windows-latest` since ~22:30Z 2026-09-05. Everything merged after that has run on Windows only through
  the Mac suite. Re-dispatch when the allowance resets; the Windows-PC acceptance test
  (`WINDOWS-FRESH-INSTALL-1.7.1-DIRECTIONS.md`) runs the same shipped suite on real Windows meanwhile.
- **Campaign blocks not yet run**: D.4 (upgrade in place from a 1.7.0 install — one reconcile, nothing
  lost), E (import → searchable within 5 minutes, timed per format), F (24-hour production telemetry
  review on the author's Mac: lag percentiles, DISHONEST = 0, audit-tick and snapshot rows).
- The campaign findings ledger (`MCP-MEMORY-PROBLEMS-AND-FIXES.md`, MEM-36…MEM-73) and every agent
  report (`MEMORY-MCP-AGENT-REPORTS-2026-09-05/`) live in the author's private notes folder beside this
  repository, not in it — the release gate refuses that folder's name in shipped files, which is how
  this sentence came to be reworded.

### Tests

- **(a79) the server keeps time** (41 checks, private suite): the `shouldSpawn` truth table
  including a clock that moved backwards; the kill switch; released-copy resolution (MEM-21); the
  lock declining a live holder, taking a dead one, releasing only its own, and — retried, with
  UNARMED failing the run — **two walks started together producing exactly one walker**; the stamp;
  and the proof that `scheduler.storeDir()` has not drifted from `config.ownStoreDir()`.
- **`test/public/scheduler-e2e.mjs`** (9 checks, ships, runs on all three platforms): a real MCP
  server over stdio, a synthetic transcript, and — with nothing else installed — the exchange in the
  store, the walk stamped `source: "server"`, the run-log line, the staging index rebuilt, and
  `latest` returning the exchange **through the same live server**. Then the control: the identical
  fixture under `MEMORY_SCHEDULER=0` is captured by nobody. ~15 s, of which 12 s is the control.

## [1.7.0] — 2026-09-05

Recent recall was unreliable for one structural reason: freshness was inferred from side channels — a
file count, a debounce stamp, whether a hook finished — instead of being checked against the store
directory itself. In three weeks that produced ten distinct ways for a captured exchange to be on disk
and not in the index (MEM-1, -2, -16/17, -18, -19, -20/F3, -21, v1.6.2's 7-hour cache, the v121 miss,
MEM-26/27). This release makes the store the truth and the index a cache, at every reader and every
writer, and measures the result. It happened twice more on 2026-09-05 while this was being written —
04:52Z and 06:39Z — both times a hook killed by the host between writing a file and indexing it.

### Added

- **`latest` and `search` read the store directly for files the index has not seen yet**
  (`lib/unindexed.js`). A `latest` query returns a just-captured exchange with
  `provenance: "unindexed-direct"`; `search` lists matching newer files under `recentUnindexed` beside
  the ranking — never inside it, because a document with no BM25 statistics and no vector cannot be
  ranked honestly. Bounded to 50 files / 5 MB per query, newest first; the same denylist and
  `metadata.secret` gates as indexing; kill switch `MEMORY_UNINDEXED_DIRECT=0`. When nothing is
  unindexed the response is byte-identical to 1.6.3 — measured, and gated by the frozen-corpus test.
  `unindexedChecked: {scanned, total, merged}` appears whenever the check had something to check.
- **`recencyVoid` narrows to files that could not be read.** A stale file that was read and did not
  match is not the answer, exactly like an indexed non-match. With the kill switch on, the 1.6.x
  warn-only behaviour is restored — the suite asserts both arms.
- **`sessions` action** — the corpus grouped by conversation: `sessionId`, title, first/last `ts`,
  exchange count, the last exchange and whether it was still being written, and `transcriptExists`.
  Sessions that exist only in files the index has not read yet are folded in as `pendingIndex: true`
  — the newest conversation appears before its first rebuild. Same freshness stamp as every other read.
- **`latest` without terms browses the newest N** (default 10, max 50; `browse: true`). Until now a
  no-term call returned `"no usable terms"` before even checking freshness, so "what was I just
  doing" could not be asked without already knowing a word from the answer. Every other filter still
  applies, and so do the direct read and the recency guard — browse is where they matter most.
- **Array and `all` scopes on `latest` carry what a named scope carries.** Sections are projected
  through one exported `SECTION_KEYS` list (29 keys), empty sections stay (`empty: true`), an absent
  index is marked `indexMissing`, and the top level aggregates the way `search()` always did —
  `indexBuiltAtByScope`, `indexStale`, `staleWarning`, `recencyVoidByScope`, a summed
  `unindexedChecked`, hoisted guidance. The absence note is conditional: when any corpus was not
  fully read it says **NOT AN ABSENCE** and names the corpus.
- **`orderedBy: "factTime"` for curated.** 388 of 419 curated documents carry a recorded
  `metadata.modified` with a declared `modifiedSource`; `latest` already ordered by it while labelling
  the order `mtime` and printing the "not chronology" warning. The label now says what the order is —
  a claim about the world, weaker than a captured `ts`, stronger than an mtime — and the three
  sentences live in one place (`CLOCK_NOTES`).
- **The staging response says when capture itself broke:** `captureHealth` (a capture run that died
  between writing and indexing) and `uncapturedSessions` (a transcript that has grown past its last
  capture). Both absent when all is well; both survive the compact `everything` view.
- **Who asked, in the query log.** Every query row written during a real MCP request carries the
  client the handshake named (`client`), the JSON-RPC `requestId`, the server process as `procId`
  (pid@startedAt — one process per Claude session; no session UUID exists over stdio), the scope and
  limit the caller actually passed (`requestedScope`, `limit` — fan-out rows used to hide an array
  scope entirely), and one `queryId` shared with a single `kind: "response"` row recording wire size
  and duration. The `live` claim is per request (`beginMcpRequest` / `endMcpRequest` bracket the
  handler), so a served request no longer makes the rest of the process `live`.
- **The index header records what it enumerated:** `sourceListing: {count, digest}` — a cheap listing
  digest every writer can compare against the store without reading a byte of content.
- **A passive recall canary** (`lib/recall-canary.js`; `store/.recall-canary.jsonl`). Two numbers,
  taken without writing into any corpus, loading a model, or starting a process: the timer logs how
  long each newly written store file stayed invisible to the index (one 4 KB header read + a stat
  pass, ~40 ms per tick), and the running server — only when a file is unindexed — asks `latest` for
  a rare token from that file and records whether the answer returned it or named it
  (`HONEST-PRESENT` / `HONEST-NAMED`; a `DISHONEST` verdict writes an alarm row). Measured on a
  2,908-document staging index: 23–33 ms when nothing is unindexed, 71–95 ms when something is, heap
  flat over 20 probes. Probe rows log as `src: "canary"` and are excluded from caller statistics.
  Kill switch `MEMORY_RECALL_CANARY=0`. Nothing consumes the alarm row yet — it is there to be read.
- **A recent-recall stress harness** (`npm run stress:recall`; `test/recall-stress/`) that runs the
  REAL capture scripts against a sandbox, kills the writer with an external watcher at four measured
  points, simulates sleep by moving file times, then asks the real handler and classifies every answer
  HONEST-PRESENT / HONEST-NAMED / DISHONEST. 18 scenarios, both the working tree and `dist/capture`,
  ~70 s; the oracle cross-checks itself against `store-audit`; committed mutations must turn exactly
  the predicted checks red. A three-scenario lite variant ships in the public suite.
- **A committed ranking snapshot** (`npm run snapshot:ranking`; `test/ranking-snapshot-gold.json`,
  46 queries over the frozen gold corpus, clock and corpus label frozen, whole canonicalised responses)
  — `--compare` exits non-zero on any difference. Every change in this release was gated on it.

### Fixed

- **A capture run killed between writing a file and rebuilding the index left that file invisible,
  and the next run said "no new exchanges; index untouched".** Writers now compare the store's listing
  digest to the index header (`reconciled` outcome with the reason; growth-aware debounce
  `MEMORY_RECONCILE_MIN_SEC`, default 120), a `.pending-index.json` marker brackets the write→index
  window (`crash-recovered`), and a `started` line with no ending is detected (`lib/ingest-health.js`).
  Rebuild-storm guard measured: 20 quiet ticks → 0 rebuilds, 180 ms per tick.
- **Array and `all` scopes dropped every freshness field.** `latestAll` copied five keys out of a
  23-key response, skipped empty sections entirely, and its own note contradicted the warning it had
  dropped. A term present only in an unindexed file came back as an unqualified zero.
- **The timer looked for RECENT transcripts, not UNCAPTURED ones.** A laptop that slept 20 minutes
  dropped its sessions out of the 15-minute window forever. Measured on the author's machine: 57
  uncaptured transcripts inside the 7-day cap, of which the old window would have selected **zero**;
  the new rule (no stamp, or size grown past the stamp; 8 per tick newest-first, deferred count
  printed) selects them. **`MEMORY_CAPTURE_WINDOW_MIN` changed meaning:** unset now means no window
  filter (it was 15 minutes); `MEMORY_CAPTURE_MAX_AGE_DAYS` (7) and `MEMORY_CAPTURE_MAX_SESSIONS` (8)
  are new.
- **The ingest log reported the store count on both sides of its own comparison.** `indexedChunks`
  was `null` on every run ever logged.
- **The extractor wrote each exchange straight to its final path.** The stress harness killed it
  mid-write and left a truncated file with no `sessionId` — invisible to `store-audit`, which groups
  by session, and indexable as a real short exchange. Now temp + rename, like every other writer.
- **`metadata.inFlight` was parsed but never projected into the index**, so the "still being written"
  warning went silent the moment the index caught up. And group (a24) could not catch its own
  headline mutation (its regex missed `unknown action`). Both fixed.
- **The multi-scope section projection was a second hand-written literal**, filtered through
  `SECTION_KEYS` only afterwards — a key added to the list was still dropped until someone also
  edited the literal. `SECTION_KEYS` is now the only place a key is named.
- **94% of "live" query-log traffic was the suite's own.** 288 of 306 rows over two days: 81 written
  straight into the real log by a test, 162 by a child that set `MEMORY_QUERY_SOURCE:'live'`, the
  rest test drivers over MCP stdio. The analyser excludes suite run ids (`isSuiteRow`), the two tests
  are sandboxed, and an end-of-suite check closes the ordering hole. Honest caller count on the same
  log: 98 → 42.
- **The BM25-only fallback for a model that fails at search time has no test, and the README now
  says why** (the index path refuses without the model by rule, so the state cannot be constructed
  in a test without the escape hatch that rule forbids).
- The MCP handshake reported version `1.1.0`; it now reads `package.json`. `includeSummaries` was
  described as "excluded by default"; summaries are demoted, `false` excludes.

### Testing

Author suite: new groups (a71) the store is truth, (a73) writers reconcile, (a74) timer selects
uncaptured, (a75) stamp surface invariance, (a76) browse / sessions / clock, (a78) who asked — every
check paired with a mutation that turns it red and a control that proves it is not vacuous. Public
suite 59 → 110 checks, including the secret-gate check for the direct-read path and the lite stress
harness. Verified in worktrees against the unmodified 69b184f baseline by failure-set diff (zero new
failures at every merge — a worktree has no live store, so ~22 corpus-dependent checks fail there
regardless), then in the main checkout before release.

## [1.6.3] — 2026-09-04

Three features were reporting into a void. Each was verified against real data before being changed.

### Fixed

- **A memory that disappears is now written down, not just warned about.** The vanish report — the
  second net under a lost memory, catching at index time what the commit hook catches at commit time
  — emitted through `console.error`, from inside a process whose stderr the host keeps nowhere. The
  question it exists to answer ("when did those memories disappear") is asked *days* later, when any
  console is long gone. It now appends JSONL beside the index: timestamp, the names that went, and
  the document counts before and after. `MEMORY_VANISH_LOG` relocates it. Verified end to end:
  delete 3 of 16 memories, rebuild, and the sink names all three with `16 → 13`.
- **The nightly curation pass now records its queue.** It runs from a hook with `2>/dev/null` and
  stdout inherited, so every proposal and candidate it found went to a console nobody reads. Two
  sinks now: `.dream-queue.json` (what is waiting right now, overwritten each run so it cannot go
  stale, with the items themselves) and `.dream-runs.jsonl` (one row per run over time). Verified
  with a **non-empty** queue — a planted credential-bearing memory is recorded as
  `{"secret-review": 1}` while the credential itself appears **zero** times in the sink.
- **Graph-spread telemetry only records real queries now.** Measured on the live query log: of
  **2,210** rows carrying `shadowDivergence`, **2,210 came from the test suite and 0 from real
  traffic**. The measurement had never once observed a real query, so any conclusion drawn from it
  would have been a statement about the project's own tests. It now applies the same `src`-based
  filter the absence probe already used.

### Testing

The public suite grows to **48 checks** — the vanish sink is now a gated contract, mutation-tested
(with the write removed, the gate reports `rows: 0` and fails).

## [1.6.2] — 2026-09-04

Found by running the v1.6.1 release through an independent adversarial test pass. Every number below
was measured, and one proposed fix was **rejected** because measuring it showed it did nothing.

### Fixed

- **A long-running server answered from an index another process had already rebuilt.** The parsed
  index is cached for the life of the process, and the freshness check compared the *corpus* against
  that cached copy — never the cached copy against the index *file*. Measured: the on-disk index had
  been rebuilt at 13:36Z while the server was still answering from 06:51Z. The same query returned
  **0 results through the server and 2 against the index on disk**, with the response saying *"No
  document in any corpus mentions every term."* A confident absence over an answer that already
  exists is the worst thing a memory system can say. `ensureFresh` now compares the on-disk
  `builtAt` (a 4 KB header read, not a parse of a 56 MB file) and re-reads when it is newer.
- **A `memoryDir` that does not exist built an empty index and reported success.** `files indexed: 0`,
  exit 0, and — measured — **zero** occurrences of `not exist`, `missing`, `ENOENT`, `warn` or `error`
  anywhere in the output. `npm run index` now names the missing path and the setting that points at
  it, and exits non-zero. A root that exists but is empty still exits 0: that is a fresh install.
- **`corpus : [object Object]`** in the index report — the corpus root list was template-stringified,
  in the first command the README tells a new user to run.
- **`MEMORY_SNAPSHOTS_PER_FILE=0` (or negative) silently deleted every snapshot**, including the one
  just written, removing the recovery path `MEMORY-SAFETY.md` advertises. Now clamped to at least 1.
  A non-numeric value already failed open; only the numeric cases failed closed.

### Removed

- **The SKU/model family-alias layer.** Re-measured against its own frozen pre-registered set:
  **0 of 12** target questions improved, bar was ≥8. It also shipped broken — `lib/aliases.js` was in
  the release tree while its generated data file was excluded, so it read a file that was not there.
  Proved to be a no-op before removal: 46 real queries snapshotted before and after **with the clock
  frozen**, byte-identical. (Unfrozen, `recencyFactor` drifts ~1e-4 an hour and looks like a change.)

### Not changed, and why

- **A long verbatim body quote can retrieve worse than a short one.** Diagnosed to the keyword
  floor, then the proposed fix was **rejected on measurement**: over 45 verbatim body sentences it
  moved nothing (rank-1 25 → 25, missing 18 → 18), and stronger settings made it worse. The floor is
  not the binding constraint. Now documented under **Known limitations** in the README, with the
  workaround, rather than silently carried.

## [1.6.1] — 2026-09-03

### Added

- **[`MEMORY-SAFETY.md`](MEMORY-SAFETY.md) — can this lose my memories?** The complete list of what
  this server writes into *your* memory folder (frontmatter stamps; new files from `import`; an
  archived copy on `import … replace`), the fact that **no code path deletes from it**, and the one
  door those writes go through:
  - a "metadata" edit whose **body** differs is refused, not written — the realistic corruption mode
    (a frontmatter-splitting bug eating content) cannot reach your disk;
  - the previous bytes are **snapshotted** to `.memory-snapshots/` first (newest 5 per file,
    `MEMORY_SNAPSHOTS_PER_FILE` to change or disable);
  - writes are **atomic**, so a crash leaves the old file or the new one, never half of either;
  - a new memory **never** overwrites an existing file; `import … replace` archives the old version
    (stamped `supersededAt`) and the writer verifies the archived copy exists before replacing.
- **`MEMORY_CURATED_READ_ONLY=1` — the server writes nothing to your memory folder at all.** It
  still indexes, searches and auto-captures into its own `store/`. Recommended for a first run
  against memories you care about: nothing in retrieval depends on the stamps it would otherwise add.
  19 checks in suite group `(a70)`, each mutation-tested (remove the guard, the test goes red).

### Changed

- **Dream supersession no longer queues work; it computes and logs (`DREAM_SUPERSESSION=shadow` is
  now the default).** Measured over its whole life: of 27 unique candidates, 6 survived
  claim-containment and **0 of those 6 were genuine** — three named memories that had already been
  corrected, three that never contained the claim. The standing rule for a judgment feature is that
  precision below 50% does not get to act. Containment itself is sound (21 of 21 rejections correct
  on inspection), so the evidence keeps accruing behind the flag; `DREAM_SUPERSESSION=on` restores
  the old behaviour.

### Fixed

- **The stale-tail pruner required only a matching *description* as evidence.** A description is the
  ask's first 40 words, and 144 files in this author's store share one with a sibling (15 of them
  described `"continue"`), so a real memory with a unique body could be deleted the moment its name
  stopped being emitted. It now requires **body identity** — a stale tail is a copy, and a matching
  description with a different body is a real memory, kept and named.
- **An agent report that quoted its own sub-agents was truncated at the inner `</result>`**, storing
  the inner envelope as prose and losing the outer conclusion. The outer report is now taken to the
  last `</result>` with nested envelopes stripped, and `[[wikilinks]]` inside a machine-written
  report are neutralised so it cannot mint graph edges.
- **The no-timestamp fallback name hashed the ask alone**, so two identical asks ("continue", twice)
  collapsed into one file and reported `wrote 2`. It now includes the turn index, and any run whose
  names are not unique **refuses and writes nothing** rather than overwriting.
- **A session holding both old and new name shapes** (a rollback, or an older copy still running) was
  ordered by name, which put a *newer* legacy file at the front of the thread and made `threadLast`
  two days stale. Such a session is now ordered by the ask timestamp.
- **The vector cache ignored `MEMORY_ROOT`**, so a released copy under `dist/capture/` would have
  re-embedded from scratch into its own cache on every release. `release-capture.sh` now smoke-checks
  the store, staging index, vector cache and local config all resolve inside the repo.
- **The migration script said "pre-checks ok" for two collision classes** and then overwrote: an
  existing new-shape file, and two sessions sharing an 8-character prefix. Both now refuse at
  pre-check with nothing touched; it also refuses a file with no usable timestamp (rather than
  inventing a name the writer would not reproduce), remaps dream state keyed by filename, and retires
  the staging index so a stale one cannot be served.
- A `<cross-session-message>` from another Claude session was folded in as if the human had typed it
  (3 files in this author's store, since rewritten).

## [1.6.0] — 2026-09-03

### Changed — on-disk format

- **Exchange names are content-stable.** `x-<sid8>-NNNN` (the exchange's *position* in the
  transcript) becomes `x-<sid8>-<ask timestamp, compacted>` — e.g. `x-fb357616-20260903T054233800Z`.
  Position was the root of every store defect found this week: a withdrawn extractor rule inserted 20
  exchanges and renumbered 715 files, leaving 19 duplicate memories; a windowed capture numbered from 1
  and overwrote a session's first two; a deletion bound computed from the ordinal removed a real
  memory. A name derived from *when the ask was made* cannot do any of those: inserting or dropping
  an exchange touches only that exchange, and a filtered run links to the same predecessor a full run
  would. The compact form is fixed-width UTC, so byte order is time order — measured over all 2,782
  files before migrating: zero duplicate stamps within a session and zero reorders. (An exchange with
  no timestamp — none exist today — gets `<day>Tx<8-hex hash of the ask>`, deterministic and visibly
  not an instant.) The `thread` reader sorts the suffix as a **string**; parsing it as a number would
  silently equate adjacent milliseconds. `scripts/migrate-stable-names.mjs` performs the one-time
  migration (dry-run by default; `--apply` rewrites `name:` and `Previous:`, renames, remaps dream
  state, and verifies count / name==basename / no dangling links / nothing old-shaped left).
- **Stale-tail pruning is now a set difference.** A file of the session whose name the extractor no
  longer yields *and* whose description duplicates one it does yield is removed on a plain full run;
  anything else is kept and named. The name set is taken before `--defer-last` pops the in-flight
  exchange (a first draft did not, and an in-flight ask that repeated an earlier one — "continue",
  twice — would have been deleted as its duplicate on a timed run). `MEMORY_PRUNE_ORPHANS=0` turns it
  off.

### Added

- **A subagent's final report joins the exchange it worked for.** An asynchronous agent's result
  arrives on the parent's timeline as `<task-notification>…<result>…</result>` — in the user role, so
  it was dropped with every other machine turn. Measured over all 556 agents on this machine: 297
  report this way, and the parent's own prose then restates a median 38% of the report's identifiers
  (SHAs, paths, line numbers); ~90% of agent conclusions were absent from the store. The `<result>`
  now appends to the reply as `**Agent report (task <id>):**`, with the human's session id as
  provenance. (Full ingestion of subagent transcripts is deliberately *not* done: 556 files, 239 MB,
  a third of whose retrieval keys are dead scratch paths or coordinator relays, and their filenames
  collapse to 16 buckets under the current session prefix — that is a separate corpus, not a walker
  flag.)
- **Capture runs from a released copy, not the working tree.** `npm run release:capture` copies
  `scripts/` + `lib/` at a committed, suite-green state to `dist/capture/` (stamped with the sha;
  refuses a dirty tree without `--force`), and `npm run install:capture-hooks` points the Claude Code
  hooks and the LaunchAgent at it with `MEMORY_ROOT=<repo>` so the copy keeps using the repo's store,
  indexes and config. Why: this week an uncommitted, untested extractor edit went live on the
  LaunchAgent's next 5-minute tick and deleted a real memory file from the gitignored store.
  `MEMORY_ROOT` is honoured by `lib/config.js`, `lib/local-config.js` and `lib/heartbeat.js`.
- **`npm run audit:store`** (`lib/store-audit.js`): per session with a transcript on disk, re-runs the
  extractor into scratch and reports `missing` (expected for live sessions), `orphan`,
  `duplicate-body`, `order` (name order ≠ ask-time order) and `dangling-prev`. Gated on fixtures in the
  suite (group a69), advisory on the live store.
- **Extractor fuzz** (group a68): random interleavings of human asks, assistant prose, tool traffic,
  thinking, task notifications and mid-turn messages; six invariants an oracle computes independently
  of the extractor (count, order, no lost reply text, every interjection kept, no tool/thinking text
  stored, idempotent, `--defer-last` drops exactly the in-flight exchange). 40 cases per seed; two
  historical defects each make it fail.
- **`npm run soak:concurrency`**: N simultaneous hook+timed pairs on one transcript (default 50);
  asserts one winner per pair, index docs == store files after every pair, no lock left, every
  process logged.
- **auto-ingest arms its log before importing anything** and writes a `started` line, so a crash
  during startup or a SIGTERM mid-run leaves a trace (a `started` with no terminal line is the
  signature). Previously an import failure exited with nothing written.

## [1.5.1] — 2026-09-03

### Fixed

- **A message you type while the assistant is still working is now captured.** The desktop client
  does not record it as a user turn: it writes a `queue-operation` (`remove`, reason
  `absorbed_mid_turn`; before 2026-08-26 the same event carried no reason) and hands the text to the
  model inside a tool result — which capture deliberately ignores. Measured across 122 sessions on
  the author's machine: **574** such messages, **0** ever became a user turn, **160** of the recent
  ones were nowhere in the store and 44 more survived only because a compaction summary happened to
  quote them. What was in them: "don't do this one yet", "ignore what I said about…", rulings,
  defect reports — corrections, which is what gets typed mid-turn.

  The message is folded into the exchange it interrupted, because that exchange's reply is what
  answered it: `**Asked:** …` followed by one `> **Added mid-reply:** …` block-quote per message
  *inside the ask paragraph* (every continuation line quoted, so a typed `# heading` cannot become
  one, and so `dream`'s correction detector — which reads everything after the ask paragraph as the
  assistant's words — never scores the user's "I got wrong" as the assistant's), with an
  `interjections: N` frontmatter count. Redaction and address scrubbing apply as to any ask. Folding
  rather than inserting keeps the positional names stable. A message the client later wrote as a
  real turn (within the next three human turns) is stored once, not twice; a `remove` with an
  unknown reason is not stored at all. Interjections that fall in a reply under the 200-char floor
  are **counted and printed**, not silently dropped. 141 of the 146 substantive lost messages are
  now first-hand retrievable.

- **A task notification landing mid-reply no longer severs the reply.** The reply scan stopped at
  the first non-assistant entry, and a `<task-notification>` arrives in the user role — so
  everything the assistant said after it attached to nothing, while the stored document read as
  complete ("Waiting for it to complete." with the 5,767-character conclusion in no file). Measured
  over the same 122 sessions: **230 cuts, 1,663 assistant turns, 912,151 characters — 9.0% of all
  assistant prose.** The reply now runs to the next *human* turn; a notification does not take over
  the open ask (so an interjection typed after one attaches to the human), and does not release an
  in-flight exchange under `--defer-last`. Old-vs-new over every transcript: store grows from
  16.72 MB to 17.83 MB. Six exchanges that had been cut below the floor now qualify, which
  renumbers four sessions once (no external `[[x-…]]` reference points into them).

- **`capture` with `sinceMinutes` no longer overwrites a session's first memories.** The name was
  built from a count of *emitted* exchanges, so a windowed run numbered the two recent exchanges
  0001 and 0002 and wrote them over the two oldest — two destroyed, two duplicated, the `Previous`
  chain crossed. Names now come from the exchange's position in the whole transcript, whatever
  filter is applied. Not observed in production; reproduced and fixed from review.

- **A rewrite keeps the account stamp — and every metadata line another writer added.** `account:`
  records who was signed in at capture; `secret: true` (exclusion), `tier:` (demotion) and
  `modified:` (fact-time) record deliberate decisions. Re-applying an extractor change to history is
  not a capture, so all of those now survive a rewrite verbatim. Without this, re-ingesting the
  affected sessions would have relabelled 182 files to whoever ran it and silently re-indexed any
  memory that had been excluded.

- **Capture bookkeeping, from a read-only adversarial review of the pipeline:**
  - the debounce stamp recorded the transcript size *after* the run, so anything appended during a
    run was marked captured and the next runs said "transcript unchanged" — the size is now read
    before the extractor runs, and no stamp is written after a failure;
  - the lock was check-then-write and released unconditionally (20 simultaneous hook+timed pairs:
    both ran 8 times, index one document short of the store 6 times while both log lines said
    "captured") — creation is now the test (`wx`), and only the holder releases;
  - auto-ingest decided "anything new?" by file *count*, so a rewrite of existing exchanges left the
    index describing the old text — it now refreshes on any write and logs `rewritten: N`;
  - every run-log line now names its `session`.

### Added

- `scripts/ingest-transcript.js --rewrite-only` — apply an extractor change to history without
  creating exchanges for sessions that were never captured. Never deletes.
- **Stale-tail pruning, narrowly.** Positional names mean an extractor rule that inserts an exchange
  renumbers every later file, and when that rule is withdrawn the tail beyond the new count is a set
  of duplicate memories — indexed and indistinguishable (this happened: 19 of them, from a rule
  withdrawn the same night). A plain full run now removes a file beyond the session's exchange count
  **only if its description duplicates a lower-numbered file of the same session**; anything else
  beyond the count is kept and named on stderr. This is the only code in the project that deletes a
  memory file, and it does not run under `--rewrite-only`, `--limit`, `--since-minutes`, or when the
  transcript yields no exchanges. Its first version bounded on the count *after* `--defer-last` had
  popped the in-flight exchange and would have deleted each session's newest memory on every timed
  run; review caught it after one real file had gone (recreated by the next plain run).
- A store slot whose `sessionId` belongs to a different session (an 8-character prefix collision) is
  refused and named, never overwritten.

### Corrected

- The 1.5.0 entry below cited "ten exchanges in one second, then a 283-minute gap" as the evidence
  for timed capture. That reading was wrong (see the box under 1.5.0). The interjection scenario
  given for the `--defer-last` fix was also wrong in this client: the message never enters the
  exchange list, so it cannot get stuck behind anything — it vanishes, which is the defect above.

## [1.5.0] — 2026-09-02

### Added

- **Capture no longer waits for a turn to end.** The capture hook fires on `Stop`, so its unit is a
  *turn* — an assistant's whole run of work between two of your messages. Measured in one real
  session: ten exchanges written in the same second, then a **283-minute gap** with nothing
  captured.

  > **Correction (1.5.1):** that measurement was misread. The burst was the first-ever ingest of a
  > session that had run uncaptured for five days, and the gap fell between two user messages — no
  > exchange existed to capture. The feature is still justified, on different grounds: a per-turn
  > hook can never reach a session that is resumed and closed without it firing; walking every
  > recently-touched transcript can. Left in place rather than rewritten, because a changelog that
  > quietly edits its own evidence is not one you can check. The data was never missing — the transcript is written continuously, verified live at
  17,222,315 → 17,233,511 bytes in 28 seconds while capture sat 2.0 minutes behind. Only the
  trigger waited.

  `npm run capture` (`scripts/timed-capture.mjs`) can now be scheduled. It walks **every**
  transcript touched inside a window, not just the most recent — running two conversations at once
  otherwise captures one and silently starves the other. It adds no state: the existing debounce
  and lock make it safe to run at any frequency.

  Timed runs are **provisional** and defer the in-flight exchange; hook runs are **final** and keep
  everything. That asymmetry is the whole design — dropping the last exchange on the hook would
  lose the final exchange of every session. A deferred exchange, once captured, is byte-identical
  to what a hook-only run would have produced.

- **Every capture run leaves one line in `.ingest-runs.jsonl`** — when, what triggered it, how many
  exchanges, whether the index refreshed, and *why* it did nothing when it did nothing. Everything
  previously went to stderr, which a hook host discards; that is exactly why "was the index stale
  because capture never ran, or ran and skipped?" was unanswerable. Rolls at a cap.

### Fixed

- A test asserted `found === true` against a `git grep` with a 1500 ms timeout, which returns
  *unknown* under load — measured at 152 ms when run alone, and it failed and passed on consecutive
  runs with no code change. The production timeout and its never-report-absent-on-timeout behaviour
  are unchanged; only the test's budget moved.

## [1.4.2] — 2026-09-02

### Security

- **A third import door is closed.** A zip whose `conversations.json` is a *symlink* was read
  before the guarded file walker ever ran, so it imported that file's contents as conversations —
  title and all — from anywhere on the machine. 1.4.1 fixed the walker; this fixes the door that
  bypasses it. The boundary check is now **one shared helper** used by every path, because a rule
  enforced in two places is a coincidence and this was the third place it was needed.

## [1.4.1] — 2026-09-02

Four more defects, all found by an agent given only this repository and told to break it.

### Security

- **`import` no longer reads files off your machine.** `unzip` restores stored symlinks, and the
  import walker followed them — so a zip containing `notes.md -> /etc/hosts` imported the host's
  `/etc/hosts` as a searchable memory, and one pointing at `~/.ssh/config` or `~/.aws/credentials`
  would import those. The recorded provenance named the temp extraction directory, so nothing in
  the corpus showed the content came from outside the archive. Folder imports had the same hole.
  Both now refuse a symlink that resolves outside the source, and **say which files were refused**.
  Contents *inside* the archive are unaffected.

- **`metadata: secret: true` now binds immediately in `search`.** Marking a memory secret excluded
  it from the corpus at load time, but search answers from the index — so until the next rebuild
  the flag did nothing there: `get` refused the memory while `search` still returned its name, its
  description and a body snippet. The check now runs at output time, on the returned rows only, and
  the response says when something was withheld.

### Fixed

- **One unreadable file no longer takes the whole memory offline.** A `chmod 000` file — or a file
  deleted between listing and reading, on a folder the design expects you to edit while the server
  runs — threw out of the corpus load. Every query then answered "no index — run `npm run index`",
  advice that could not help because the rebuild threw the same error, and asking for a healthy
  memory returned an error naming a *different* file. Bad files are now skipped and named with
  their reason, and the rest of the corpus keeps serving.

- **A wrong-length vector in an index is refused instead of silently hiding documents.** The
  base64 path validated the dimension; the plain-array path did not. A short array made `cosine`
  return `NaN`, and `NaN` loses every comparison — so affected documents did not rank low, they
  **disappeared** from results while the response still said `confidence: "high"`.

## [1.4.0] — 2026-09-02

A security audit — 37 probes across path traversal, injection, SSRF, secret handling and resource
limits. Twenty categories were clean. Three were not.

### Security

- **A symlink inside your corpus can no longer read outside it.** Planting `passwd.md ->
  /etc/passwd` in the corpus directory got `/etc/passwd` indexed, searchable, and returned in full.
  The effective boundary was not your corpus directory but *everything reachable from it* — and the
  contents end up in an index on disk and in a model's context. Paths are now resolved with
  `realpath` and anything landing outside the root is refused. **A symlink that stays inside your
  corpus still works**, since that is a legitimate way to organise notes.

- **AWS access keys and private keys are now redacted.** The pattern for prefixed API keys required
  a `-` or `_` after the prefix — correct for `sk-…` and `ghp_…`, wrong for AWS, whose key ids are
  `AKIA` followed immediately by 16 characters. So an AWS key pasted into a memory was indexed in
  plaintext, written to the index file, and returned to the caller. Same for
  `-----BEGIN … PRIVATE KEY-----`. Both were already caught by the bundled commit hook, so the two
  lists had drifted apart. Deliberately narrow: IAM *identifiers* (`AIDA…`, `AROA…`), public keys
  and certificates are **not** redacted, because over-redaction corrupts documentation.

- **The tool now states that what it returns is content, not instruction.** A memory whose body
  reads "ignore all previous instructions…" is returned verbatim — refusing to show a memory for
  containing imperative text would be worse — but nothing said it was retrieved data. This corpus
  is written by an assistant and read by an assistant, so text that lands in it comes back later
  carrying authority it never earned.

### Clean, and worth stating

Path traversal via `get` (7 shapes), scope and library-category path injection (5), `section:`
traversal and out-of-range offsets, names containing NUL or newlines, the write side, SSRF from
URLs in corpus text, and shell metacharacters in corpus content reaching the git join — **all
refused already**. No token or handshake was added: this server has no network listener at all
(stdio only), so a token would guard a door that does not exist.

## [1.3.1] — 2026-09-02

Everything here was found by two reviewers who knew nothing about this project — one told to break
it, one told to follow the README as a newcomer. Both found things the author could not see.

### Fixed

- **`latest` no longer returns nothing on a fresh install.** It defaults to the `staging` corpus,
  which is populated by the capture hook — so a new user who did exactly what the README says
  (point `MEMORY_DIR` at a folder of notes) got `results: []` plus advice to run an index command
  that could not help them. It now falls back to `curated` when staging is absent or empty, and
  **says so** in a `scopeFallback` field rather than switching silently. An explicit scope is
  always obeyed, including an explicitly empty one.

- **`latest` no longer reports substring matches as if they were mentions.** The substring filter
  is deliberate — it is what lets a commit SHA or `v111` find the document that cites it. Reporting
  the count without saying so was not: asked about a Rust rewrite that never happened, it returned
  `totalMentions: 509` with results dated today, one carrying a git-verified commit, under
  *"results[0] is the last thing said about this"* — and every match was the word **trust**. The
  response now carries `termFrequenciesWholeWord` beside `termFrequencies` and leads with a warning
  when a term matches in no document as a separate word. Filtering and ordering are unchanged.

### Documentation

Corrected in the README and CONTRIBUTING: broken backticks and a link to a section that does not
exist; corpus statistics that read as properties of *your* corpus; **an example memory file, which
1,174 lines never showed**; "twelve actions" vs thirteen; a duplicated environment row; two
commands that do not exist in the distribution; the claim that a demote/promote round trip is
"byte-for-byte reversible" (it is not, for a file that had no frontmatter); and twelve `test/…`
paths that read as instructions to open files this distribution deliberately excludes.

Also newly documented: **the absence verdict is less reliable on a small corpus**, which is the
day-one condition. Measured at 5 of 20 answerable questions refused on a 122-file corpus, and 3 of
4 on a 13-file one. It fails safe — the right document is in `bestWeak` — but on a young corpus
read `bestWeak` before believing a refusal.

## [1.3.0] — 2026-09-02

### Added

- **`latest` no longer promises recency it cannot deliver.** When files the index has not read are
  newer than the newest row it can rank, the response now says so, names those files, and stops
  claiming `results[0]` is the last word. The observed failure: the answer sat in a file written at
  17:02, the index was built at 00:24, and the response reported 25 unread files *and still* returned
  the previous day's document as the last word. Additive — every other field, including the git
  verification layer, is unchanged.

- **The indexer reports documents that vanished.** When a document present in the last index is gone
  from the corpus, it is named. Report only; the refusal guards added in 1.2.0 handle the
  catastrophic cases. `MEMORY_VANISH_REPORT=0` disables it.

- **Memories record the instruction they were written under** (`originTask`, plus `originSessionId`).
  A rule given to one session was being read by later sessions as a universal standing rule. A
  `feedback` memory that carries the field now says, on read, that a rule is not automatically
  universal. Captured from the last user instruction at write time, redacted and truncated; memories
  written earlier simply have no value, and absence is left as absence rather than guessed.

### Changed

- The bundled `commit-memories` hook stamps every missing metadata field rather than stopping at the
  first one present, so a memory written before a field existed can gain it later.

## [1.2.1] — 2026-09-02

### Removed

- **The "ordinary words" shadow instrumentation is no longer distributed.** 1.2.0 shipped
  `lib/ordinary-shadow.js` and documented two environment variables for it. That was a mistake on
  my part: it is an unproven measurement running under a pre-registration whose own reading rule
  says it earns a *proposal*, not a behaviour — so it belongs in the tree where it is being
  measured, not in everyone's install. It never changed an answer, and removing it changes none
  either.

### Changed

- **Telemetry can no longer break search.** `lib/search.js` now loads its instrumentation lazily
  and optionally: if the module is missing or fails to load, searching continues with a no-op and
  says nothing about it. This is what makes the removal above possible, and it is the right shape
  regardless — a measurement module should never be a hard dependency of the thing it measures.

## [1.2.0] — 2026-09-02

### Changed

- **Index files are about a third the size, and load roughly three times faster.** Embedding
  vectors are now stored as base64-encoded float32 rather than as JSON number arrays
  (`INDEX_FORMAT_VERSION` 1 → 2). Measured on a 2,676-document corpus: index file
  **158.8 MB → 55.7 MB**, time to **parse the index** **1291 ms → 412 ms**, peak memory while
  loading **877 MB → 435 MB**. A server that has answered a query against that corpus settles at
  **759 MB instead of 1307 MB**.

  *(Corrected after 1.3.0: this line first said "first query after start", which is not what was
  measured — a first query also pays model load, about 250–350 ms, which this change does not
  touch. The parse figure is the honest one.)*

  **Your existing index keeps working and is not re-embedded.** The reader accepts both formats, so
  a version-1 index loads unchanged; it is rewritten in the new format the next time you rebuild.
  Verified bit-for-bit: 725,760 stored values compared, zero differences, zero changes to any
  search result.

  Vectors are also held as `Float32Array` in memory. This is not a precision change — the values
  were already 32-bit and merely stored in 64-bit slots. Measured across a fixed query set: every
  score identical, zero rank changes.

- **An older release refuses a version-2 index by name** instead of silently finding no vectors and
  answering from keyword search alone. If you downgrade, you will see a clear header refusal telling
  you to upgrade or rebuild — not a quietly worse server.

### Added

- **`memory({action:"get", name, brief:true})`** — returns the text and where it came from, without
  the ~25 provenance and freshness fields. Useful when you have already decided to read a memory and
  just want its content. The default response is unchanged. Truncation bookkeeping (`totalChars`,
  `returnedChars`, `truncated`, `readNote`) is always kept, so a partial read is never mistaken for a
  whole document.

- **The indexer refuses to destroy an index it was asked to refresh.** Two guards:
  a build from an empty root list is refused (a corpus whose directories are unconfigured resolves to
  nothing, and that is not an instruction to erase), and a build that finds **zero** documents where
  the existing index has some is refused with both counts named. A drop of more than half warns
  rather than refuses. `allowEmpty` / `allowShrink` override. Both fail open when they cannot tell:
  a first build, or an unreadable existing index, is never blocked.

- **Deleted memories are held back from the automatic commit.** If you use the bundled
  `commit-memories` hook, a removed `*.md` is no longer staged: it stays in `HEAD`, the removal is
  reported with the exact command to undo it, and everything else in the same turn still commits.
  `--accept-deletions` commits removals deliberately; `--status` reports what is being held.

- **`MEMORY_VEC_ENCODING`** — `base64` (default) or `array` to write the pre-1.2 shape, for handing
  an index to an older build.

### Fixed

- A document that links to itself no longer appears in its own `links`. Backlinks already excluded
  self; the two sides now agree.

## [1.1.0] — 2026-09-01

First public release.

A two-tier hybrid retrieval MCP server over a folder of markdown files: BM25F + dense embeddings +
phrase evidence, with an absence layer that reports having nothing rather than returning the best of
a bad set.

Notable behaviour, since there is no earlier entry to diff against:

- **Absence is a first-class answer.** When the distinctive words of a question appear nowhere in the
  corpus, or nothing scores, the server says so and returns the nearest documents clearly labelled as
  *not* answers.
- **`action:"latest"` for state questions** — a term filter ordered newest-first, because relevance
  ranking cannot answer "did X finish": "we are starting X" and "X is done" are equally about X.
- **Secrets are scrubbed on the way in**, with a final pattern sweep over the serialized index; the
  bundled commit hook refuses to run if a git remote exists while plaintext credentials are present.
- **Windows correctness**: UTF-8 BOMs and CRLF line endings in frontmatter and bodies are handled.
- **Every query is logged locally** for measurement (`MEMORY_QUERY_LOG`, `0` disables).

[1.8.1]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.8.1
[1.8.0]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.8.0
[1.5.0]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.5.0
[1.4.2]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.4.2
[1.4.1]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.4.1
[1.4.0]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.4.0
[1.3.1]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.3.1
[1.3.0]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.3.0
[1.2.1]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.2.1
[1.2.0]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.2.0
[1.1.0]: https://github.com/dfrancislyondflabc-tech/agentic-recall/releases/tag/v1.1.0
