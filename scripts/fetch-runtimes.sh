#!/usr/bin/env bash
# fetch-runtimes.sh — download the Node runtimes + win32 sharp prebuild that the
# `portable` zip bundles. Kept OUT of git (.runtime-cache is ~190 MB of binaries
# that are not ours); this script makes the cache reproducible instead.
set -euo pipefail
NV="${1:-v22.21.0}"
SHARP="${2:-0.32.6}"
RC="$(cd "$(dirname "$0")/.." && pwd)/.runtime-cache"
mkdir -p "$RC"; cd "$RC"
[ -f node-win-x64.exe ] || curl -sSL -o node-win-x64.exe "https://nodejs.org/dist/$NV/win-x64/node.exe"
[ -f node-darwin-arm64 ] || { curl -sSL -o d.tgz "https://nodejs.org/dist/$NV/node-$NV-darwin-arm64.tar.gz"
  tar -xzf d.tgz "node-$NV-darwin-arm64/bin/node"; mv "node-$NV-darwin-arm64/bin/node" node-darwin-arm64
  rm -rf d.tgz "node-$NV-darwin-arm64"; }
[ -d sharp-win32-x64 ] || { curl -sSL -o s.tgz \
  "https://github.com/lovell/sharp/releases/download/v$SHARP/sharp-v$SHARP-napi-v7-win32-x64.tar.gz"
  mkdir -p sharp-win32-x64; tar -xzf s.tgz -C sharp-win32-x64; rm -f s.tgz; }
[ -d libvips-win32-x64 ] || { curl -sSL -o v.tgz \
  "https://github.com/lovell/sharp-libvips/releases/download/v8.14.5/libvips-8.14.5-win32-x64.tar.gz"
  mkdir -p libvips-win32-x64; tar -xzf v.tgz -C libvips-win32-x64; rm -f v.tgz; }
echo "runtime cache ready in $RC:"; ls -lh "$RC" | tail -n +2 | awk '{print "  "$9"  "$5}'
