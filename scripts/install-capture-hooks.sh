#!/bin/zsh
# scripts/install-capture-hooks.sh — point the Claude Code hooks and the LaunchAgent at the RELEASED
# capture copy (dist/capture) instead of the working tree. Idempotent. Run after release-capture.sh.
#
#   npm run install:capture-hooks
#
# Writes:
#   ~/Library/LaunchAgents/com.dfl.memory-timed-capture.plist   (ProgramArguments -> dist, MEMORY_ROOT env)
#   ~/.claude/settings.json                                      (every hook command that names
#                                                                 <repo>/scripts/*.js -> <repo>/dist/capture/scripts/*.js,
#                                                                 prefixed with MEMORY_ROOT=<repo>)
# A backup of settings.json is left beside it as settings.json.bak-<timestamp>.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO/dist/capture"
[ -f "$DIST/RELEASE" ] || { echo "no released copy at $DIST — run: npm run release:capture" >&2; exit 2; }
NODE=$(command -v node)
PLIST="$HOME/Library/LaunchAgents/com.dfl.memory-timed-capture.plist"
SETTINGS="$HOME/.claude/settings.json"

# ---- LaunchAgent ------------------------------------------------------------------------------
launchctl unload "$PLIST" 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dfl.memory-timed-capture</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIST/scripts/timed-capture.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMORY_ROOT</key><string>$REPO</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><false/>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardOutPath</key><string>/tmp/memory-timed-capture.log</string>
  <key>StandardErrorPath</key><string>/tmp/memory-timed-capture.log</string>
  <key>Nice</key><integer>5</integer>
</dict>
</plist>
EOF
launchctl load "$PLIST"
echo "LaunchAgent -> $DIST/scripts/timed-capture.mjs (MEMORY_ROOT=$REPO)"

# ---- Claude Code hooks --------------------------------------------------------------------------
cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d%H%M%S)"
REPO="$REPO" DIST="$DIST" SETTINGS="$SETTINGS" node - <<'EOF'
const fs = require('fs');
const { REPO, DIST, SETTINGS } = process.env;
const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
let changed = 0;
const rewrite = (cmd) => {
  // Accept a command already pointing at dist (idempotent) or at the working tree.
  const re = new RegExp(`(?:MEMORY_ROOT=\\S+ )?node ${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/dist/capture)?/scripts/([\\w.-]+\\.m?js)`);
  const m = re.exec(cmd);
  if (!m) return cmd;
  const next = cmd.replace(m[0], `MEMORY_ROOT=${REPO} node ${DIST}/scripts/${m[1]}`);
  if (next !== cmd) changed++;
  return next;
};
for (const [event, groups] of Object.entries(s.hooks || {})) {
  for (const g of groups) for (const h of (g.hooks || [])) if (h.type === 'command' && h.command) h.command = rewrite(h.command);
}
fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
console.log(`hooks rewritten: ${changed}`);
for (const [event, groups] of Object.entries(s.hooks || {}))
  for (const g of groups) for (const h of (g.hooks || [])) if (h.command && /memory-mcp-server/.test(h.command)) console.log(`  ${event}: ${h.command}`);
EOF
echo "done. Claude Code picks up settings.json on its next session; the LaunchAgent is reloaded now."
