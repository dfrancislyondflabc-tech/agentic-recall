# Can this lose my memories?

The honest answer, with the mechanism, so you can check rather than trust.

## What it writes, and where

Two directories, and they are not the same kind of thing:

| | what lives there | who writes it |
|---|---|---|
| **your memory folder** (`memoryDir`) | the memories **you** wrote, plus anything you `import` | you, your editor, Claude — and this server, only as described below |
| **the store** (`store/`, inside the install) | auto-captured conversation exchanges, entirely this server's own bookkeeping | this server |

Everything destructive this project has ever done, it did to **its own store** — never to a memory
folder. That is not luck; it is the only place the code is allowed to delete.

## Into your memory folder, the complete list

1. **Frontmatter stamps.** `tier:` (from `demote`/`promote`), `modified:` (a fact-time stamp), and
   `account:`/`originSessionId:`/`originTask:` (which conversation a memory came from). These
   rewrite the YAML block at the top of a file and nothing else.
2. **New files**, from `import` — a new name that did not exist.
3. **Archiving**, from `import … replace` — the previous version is *moved* to `archive/`, stamped
   `supersededAt`, never deleted.

**There is no code path in this server that deletes a file from your memory folder.** `demote` moves
a memory to a lower tier by editing one YAML line; it does not move or remove the file.

## The one door, and what it enforces

Every one of those writes goes through `lib/safe-write.js`:

- **A "metadata" edit whose body differs is refused, not written.** The previous body and the new
  body are compared byte for byte first. This is the guarantee that matters: the realistic way a
  program corrupts a markdown file is a frontmatter-splitting bug that eats content, and that class
  cannot reach your disk.
- **The previous bytes are snapshotted first**, to `<your memory folder>/.memory-snapshots/<name>.<timestamp>.md`,
  newest 5 per file. So even a *correct* stamp is undoable without git. Set
  `MEMORY_SNAPSHOTS_PER_FILE=0` to keep none, or a larger number to keep more.
- **Writes are atomic** (temp file + rename): a crash or a full disk leaves the old file or the new
  one, never half of either.
- **A new memory never overwrites an existing file.**

## If you want the guarantee instead of the argument

```
MEMORY_CURATED_READ_ONLY=1
```

The server indexes and searches your memory folder and **writes nothing to it at all** — no stamps,
no imports, no archiving. Auto-capture into `store/` still works, because that is the server's own
directory. Set it in your MCP config's `env` block.

This is the setting to use if you are pointing the server at memories you care about and have not
yet built any trust in it. Nothing about retrieval depends on those stamps: `tier` and `modified`
affect ranking and recency, and their absence is a normal, supported state.

## What the tests actually prove

Suite group `(a70)`, 19 checks, and every one of them is mutation-tested — the guard is removed and
the test must go red:

| the guard | what fails when it is removed |
|---|---|
| body-identity check | a content-changing "metadata" edit is written (5 checks red) |
| snapshot-before-write | the previous bytes are gone (1 red) |
| `MEMORY_CURATED_READ_ONLY` | the folder is written to anyway (3 red) |
| never-overwrite on create | a second write clobbers the first (1 red) |
| snapshot cap | snapshots grow without bound (1 red) |

Plus `npm run audit:store`, which compares the capture store against the transcripts it came from
and reports anything it cannot explain.

## Recommended setup for imported memories

1. **Keep them under version control.** `npm run commit-memories` gives the folder a git history and
   the `Stop` hook commits changes as they happen. This is the strongest protection available and it
   is not specific to this server — an editor, a sync client or a mistaken `mv` are likelier than we
   are.
2. **Start with `MEMORY_CURATED_READ_ONLY=1`.** Turn it off when you want tier/recency stamps.
3. **Leave snapshots on.** They cost a few KB per edited file.
4. **Point `memoryDir` at the folder you mean.** The server refuses to read outside its configured
   roots (symlinks included), so a wrong path fails loudly rather than wandering.

## What is *not* protected

- Anything you do to the folder yourself.
- `store/` is the server's own and is pruned by design: an auto-captured exchange that a changed
  extractor rule no longer produces, and that duplicates one it does produce, is removed. That
  logic never looks outside `store/`, and `MEMORY_PRUNE_ORPHANS=0` disables it.
- The index (`.memory-index.json`), the vector cache and the logs are derived files; delete them any
  time and they rebuild.
