#!/bin/bash
# Loads the Social Zeitgeist home collector into launchd (every 15 minutes). Safe to re-run.
set -e
PLIST="$HOME/Library/LaunchAgents/com.reshape.socialzeitgeist.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.socialzeitgeist"
# twscrape needs Python 3.10+. Prefer uv (it brings its own Python and the packages); fall back to python3.
UV="$(command -v uv || ls "$HOME/.local/bin/uv" 2>/dev/null || true)"
if [ -n "$UV" ]; then
  ARGS="<string>$UV</string><string>run</string><string>--quiet</string><string>--python</string><string>3.12</string><string>--with</string><string>twscrape</string><string>--with</string><string>requests</string><string>$HOME/.socialzeitgeist/home_collector.py</string>"
else
  ARGS="<string>$(command -v python3)</string><string>$HOME/.socialzeitgeist/home_collector.py</string>"
fi
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.reshape.socialzeitgeist</string>
  <key>ProgramArguments</key><array>$ARGS</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.socialzeitgeist/collector.log</string>
  <key>StandardErrorPath</key><string>$HOME/.socialzeitgeist/collector.err</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Social Zeitgeist collector loaded: runs every 15 minutes, log in ~/.socialzeitgeist/collector.log"
