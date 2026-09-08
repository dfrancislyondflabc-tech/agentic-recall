#!/bin/zsh
# scripts/release-capture.sh — publish the CAPTURE code the hooks and the LaunchAgent run.
#
#   npm run release:capture            (refuses if scripts/ or lib/ have uncommitted changes)
#   npm run release:capture -- --force (release the dirty tree anyway — say why in the commit later)
#
# WHY A RELEASED COPY. The Stop/SessionEnd hooks and com.dfl.memory-timed-capture ran
# scripts/auto-ingest.js straight from the WORKING TREE. 2026-09-03: an uncommitted, untested edit to
# the extractor went live on the LaunchAgent's next 5-minute tick and deleted a real memory file from
# the gitignored store (MEM-21). A half-edited script must not be able to touch the store.
#
# dist/capture/ is a copy of scripts/ + lib/ + package.json at a COMMITTED state, stamped with the
# sha. node_modules and the model cache are symlinked (identical, large). The copy is pointed back at
# THIS repo's data by MEMORY_ROOT (lib/config.js), so store/, the indexes, local-config.json and the
# heartbeat are the same files the working tree uses — only the CODE is frozen.
#
# The hooks (~/.claude/settings.json) and the LaunchAgent plist must run
#   MEMORY_ROOT=<repo> node <repo>/dist/capture/scripts/<script>
# scripts/install-capture-hooks.sh writes both.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO/dist/capture"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

cd "$REPO"
DIRTY=$(git status --porcelain -- scripts lib package.json | wc -l | tr -d ' ')
if [ "$DIRTY" != "0" ] && [ "$FORCE" = "0" ]; then
  echo "refusing: $DIRTY uncommitted change(s) under scripts/, lib/ or package.json — commit first, or --force" >&2
  git status --short -- scripts lib package.json >&2
  exit 2
fi
SHA=$(git rev-parse --short HEAD)
VER=$(node -e 'console.log(require("./package.json").version)')

# Suite must be green for the code being released. Cheap insurance against releasing a red tree.
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "running the suite before release (SKIP_TESTS=1 to skip)…"
  if ! npm test >"/tmp/release-capture-test.log" 2>&1; then
    echo "refusing: npm test failed — see /tmp/release-capture-test.log" >&2; exit 3
  fi
  grep -E "passed, " /tmp/release-capture-test.log | tail -1
fi

STAGE="$REPO/dist/.capture-staging.$$"
rm -rf "$STAGE"; mkdir -p "$STAGE"
rsync -a --delete --exclude '.DS_Store' "$REPO/scripts/" "$STAGE/scripts/"
rsync -a --delete --exclude '.DS_Store' "$REPO/lib/" "$STAGE/lib/"
cp "$REPO/package.json" "$STAGE/package.json"
ln -s "$REPO/node_modules" "$STAGE/node_modules"
printf 'version=%s\nsha=%s\nreleased=%s\nforce=%s\n' "$VER" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FORCE" > "$STAGE/RELEASE"

# Smoke: the released copy must load its own libs and resolve the REPO's data -- store, staging
# index, vector cache, local config -- never its own. (The vector cache was the one path that derived
# from its own file location; a copy would have re-embedded 47,900 vectors into dist/ on every release.)
GOT=$(MEMORY_ROOT="$REPO" node -e "
Promise.all([import('$STAGE/lib/config.js'), import('$STAGE/lib/vector-cache.js'), import('$STAGE/lib/local-config.js')]).then(([c,v,l]) => {
  console.log([c.ownStoreDir(), c.stagingIndexPath(), v.cachePath(), l.LOCAL_CONFIG_PATH].join('\n'));
})")
while IFS= read -r p; do
  case "$p" in "$REPO"/*) ;; *) echo "refusing: released copy resolves a data path outside the repo: $p" >&2; rm -rf "$STAGE"; exit 4;; esac
done <<< "$GOT"
echo "smoke: store/index/cache/config all resolve under $REPO"

# Atomic swap so a hook firing mid-release sees either the old copy or the new one.
mkdir -p "$REPO/dist"
if [ -d "$DIST" ]; then mv "$DIST" "$DIST.prev.$$"; fi
mv "$STAGE" "$DIST"
rm -rf "$DIST.prev.$$"
echo "released capture code $VER@$SHA -> $DIST"
cat "$DIST/RELEASE"
