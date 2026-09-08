#!/bin/bash
# Double-click this. It works out where you put this folder, checks that Node actually runs
# here, and opens a page with the exact text to paste into Claude.
#
# ONE ENTRY POINT, BOTH DOWNLOADS (MEM-70). The portable zip bundles ./runtime/node; the plain
# zip does not and uses the Node already on this machine. Everything after that is identical.
cd "$(dirname "$0")" || exit 1
echo
echo "  Setting up the Memory server for Claude..."
echo
# macOS quarantines anything that arrived in a downloaded zip. Without this the bundled Node is
# killed on sight and the error ("cannot be opened") names Apple, not this folder, which sends
# people hunting in the wrong place.
xattr -dr com.apple.quarantine . 2>/dev/null
if [ -f runtime/node ]; then
  chmod +x runtime/node 2>/dev/null
  NODE=./runtime/node
elif command -v node >/dev/null 2>&1; then
  NODE=node
else
  echo "  ERROR: this download does not bundle a Node runtime, and Node is not installed."
  echo "  Install Node 20 or newer from https://nodejs.org, then run this again."
  echo "  (The portable download needs nothing installed — it carries its own runtime.)"
  read -n 1 -s -r -p "  Press any key to close."; exit 1
fi
"$NODE" packaging/setup-page.mjs
RC=$?
echo
[ $RC -ne 0 ] && echo "  The check FAILED. SETUP.html explains what went wrong." || echo "  Ready. Opening SETUP.html..."
open SETUP.html 2>/dev/null
echo
read -n 1 -s -r -p "  Press any key to close."
echo
