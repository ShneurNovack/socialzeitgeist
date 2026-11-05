#!/bin/bash
# Loads the Social Zeitgeist home collector into launchd (every 15 minutes). Safe to re-run.
set -e
PLIST="$HOME/Library/LaunchAgents/com.reshape.socialzeitgeist.plist"
PY="$(command -v python3)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.socialzeitgeist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.reshape.socialzeitgeist</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$HOME/.socialzeitgeist/home_collector.py</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.socialzeitgeist/collector.log</string>
  <key>StandardErrorPath</key><string>$HOME/.socialzeitgeist/collector.err</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Social Zeitgeist collector loaded: runs every 15 minutes, log in ~/.socialzeitgeist/collector.log"
