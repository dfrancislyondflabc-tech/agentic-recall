#!/usr/bin/env bash
# scripts/build-public-tree.sh — stage the shareable tree, and refuse to produce a dirty one.
#
#   ./scripts/build-public-tree.sh <dest-dir>
#
# Produces a DIRECTORY, not a zip, because the destination is a fresh public repository
# whose first commit is this tree. (Zip it afterwards if you want to hand someone a file.)
#
# THE EXCLUSIONS ARE THE POINT. Everything here ships from `git archive HEAD`, so the
# tracked files ARE the release. The list itself lives in packaging/release-exclude.json
# — shared with scripts/build-zip.sh, which used to have no list at all — and every entry
# there carries the reason it is there. Three kinds of thing are removed:
#
#   1. THE TEST SUITE. 5,300 lines that assert against one particular corpus — it fails
#      for anyone else, and it holds internal host addresses, a real person's email and a
#      fixture directory named after the author. Excluding it removes an entire class of exposure
#      and costs the recipient nothing they could have used. A synthetic fixture corpus
#      would let it ship one day; that is a separate project.
#   2. VENDOR DOMAIN DATA. The alias table is 1,034 product models scraped from one
#      manufacturer, for a feature that is OFF by default and has never been switched on.
#      Deleting it is measurably free: search returns byte-identical scores without it,
#      and lib/aliases.js already falls back to an empty table. The MECHANISM stays and is
#      documented as "supply your own alias-table.json".
#   3. ONE MACHINE'S PLUMBING. The author's packaging script, the CI workflows that grep
#      for a plaintext credential, and the measurement harnesses bound to their corpus.
#
# AND THEN IT CHECKS. A list of exclusions is a promise; the gate is the proof. If
# check-release-clean.mjs finds anything, the staged tree is DELETED rather than left
# lying around to be published by someone who did not read the output. A refusal that
# leaves the artefact behind is not a refusal.
set -euo pipefail

DEST="${1:-}"
[ -n "$DEST" ] || { echo "usage: $0 <dest-dir>"; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -e "$DEST" ]; then
  echo "refusing: $DEST already exists — name a fresh directory"; exit 2
fi

# Uncommitted work would silently not ship (git archive reads HEAD), and the recipient
# would get something that never existed as a commit.
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "refusing: working tree is dirty — commit first, because the tree ships from HEAD"
  git -C "$ROOT" status --short | sed 's/^/    /'
  exit 2
fi

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
echo "== staging tracked files from HEAD ($SHA)"
mkdir -p "$DEST"
git -C "$ROOT" archive HEAD | tar -x -C "$DEST"

echo "== removing what must not ship"
# THE LIST IS DATA, IN ONE PLACE: packaging/release-exclude.json, with a `why` on every
# entry (the reasoning that used to live in this array is preserved there, verbatim).
# scripts/release-tree.mjs applies it, re-adds the two shippable test subtrees, and
# repoints any npm script whose target was removed.
#
# 🟥 IT IS SHARED WITH scripts/build-zip.sh ON PURPOSE. While the list lived HERE, the
# zip builder had no way to read it and shipped `git archive HEAD` — everything tracked —
# under a printed line saying "verified: no personal content". Two builders, one list, so
# an exclusion added for one artefact cannot go missing from the other.
if ! node "$ROOT/scripts/release-tree.mjs" prune "$DEST"; then
  echo; echo "REFUSED — could not stage a pruned tree; deleting $DEST so it cannot be published."
  rm -rf "${DEST:?}"; exit 5
fi

# (the alias layer was removed in v1.6.2 — 0 of 12 target questions improved against its
#  own pre-registered bar, and it shipped reading a data file that was excluded)

# Document the per-machine file that is deliberately absent.
cat > "$DEST/local-config.example.json" <<'NOTE'
{
  "_comment": "Copy to local-config.json (gitignored) and edit. Every value is optional; environment variables override it.",
  "memoryDir": "/absolute/path/to/your/memories",
  "libraryDir": "/absolute/path/to/your/reference/library",
  "keepEmailDomains": ["your-org.example"],
  "keepEmails": ["you@example.com"]
}
NOTE
echo "    + local-config.example.json"

# WHICH COMMIT THIS TREE WAS CUT FROM. Without .git the server reports @unknown-sha, and
# the one check that catches a stale running process — comparing serverVersion against the
# code you are reading — cannot be performed at all. That check exists because a config
# change was once verified in a fresh process and reported as live while the running server
# still had the old build. A tarball install should not lose it.
cat > "$DEST/.build-stamp.json" <<STAMP
{
  "sha": "$(git -C "$ROOT" rev-parse HEAD)",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "builtBy": "scripts/build-public-tree.sh",
  "_comment": "Read by lib/version.js ONLY when there is no .git. A clone reports its live HEAD instead."
}
STAMP
echo "    + .build-stamp.json ($(git -C "$ROOT" rev-parse --short HEAD))"

# ONE MACHINE'S DENYLIST IS NOT A POLICY. secrets-exclude.json is two things at once: the
# PATTERNS, which are a genuine contribution and should ship, and `excludeFiles`/`sectionScrub`,
# which name this machine's memory files and headings. Publishing those does not just leak a
# filename, it publishes WHERE the author keeps a credential. The patterns stay; the personal
# lists are emptied HERE rather than in the repo, so the private machine keeps the protection it
# actually relies on. Found by a vendor-term sweep of the staged tree, not by the gate — the gate
# checks for known terms, and a filename nobody hashed is invisible to it.
node -e '
const fs=require("fs"), p=process.argv[1], c=JSON.parse(fs.readFileSync(p,"utf8"));
const had=(c.excludeFiles||[]).length + Object.keys(c.sectionScrub||{}).length;
c.excludeFiles=[]; c.sectionScrub={};
c._comment=(c._comment?c._comment+" ":"")+
  "excludeFiles and sectionScrub ship EMPTY: they are per-machine. excludeFiles takes memory "+
  "FILENAMES that must never be indexed; sectionScrub maps a filename to headings to strip. "+
  "This file is public, so name files by path, not by what they contain.";
fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
console.log("    ~ secrets-exclude.json: emptied "+had+" per-machine entr(ies), kept "+(c.patterns||[]).length+" patterns");
' "$DEST/secrets-exclude.json"

# ASK THE TREE, DO NOT RE-READ THE LIST. This class has now bitten twice, and both times the
# exclusion list was inspected and both times the miss survived. scripts/audit-read-paths.mjs
# resolves every literal path the shipped code reads against the staged tree.
echo "== audit: does anything here read a file that did not ship?"
if ! node "$ROOT/scripts/audit-read-paths.mjs" "$DEST"; then
  echo; echo "REFUSED — staged tree deleted so it cannot be published."; rm -rf "${DEST:?}"; exit 4
fi

echo "== gate: does this tree name anyone?"
if ! node "$ROOT/scripts/check-release-clean.mjs" "$DEST"; then
  echo
  echo "REFUSED — staged tree deleted so it cannot be published by accident."
  rm -rf "${DEST:?}"
  exit 3
fi

FILES="$(find "$DEST" -type f | wc -l | tr -d ' ')"
echo
echo "OK — $FILES files staged at $DEST (from $SHA)"
echo "Next: add a LICENSE, then 'git init && git add -A && git commit' in that directory."
echo "Do NOT push it to the private remote — this is a fresh-history tree by design."
