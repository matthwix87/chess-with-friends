#!/usr/bin/env bash
# Run a test page in headless Firefox and wait for the "<suite> DONE" line.
# Usage: tests/run-headless.sh <page.html> <suite> [timeout_seconds]
# Requires tests/serve.ps1 running on port 8765.
set -u
PAGE="$1"; SUITE="$2"; TIMEOUT="${3:-120}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/out/log.txt"
FF="/c/Program Files/Mozilla Firefox/firefox.exe"
PROFILE="$(mktemp -d)"
mkdir -p "$DIR/out"; : > "$LOG"
# Allow autoplay/WebRTC without prompts in the throwaway profile.
cat > "$PROFILE/user.js" <<'EOF'
user_pref("media.navigator.permission.disabled", true);
user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);
user_pref("media.autoplay.default", 0);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
EOF
"$FF" -headless -no-remote -profile "$(cygpath -w "$PROFILE")" "http://localhost:8765/tests/$PAGE" >/dev/null 2>&1 &
PID=$!
for ((i = 0; i < TIMEOUT; i++)); do
  if grep -q "$SUITE DONE" "$LOG" 2>/dev/null; then break; fi
  sleep 1
done
export WP="$(cygpath -w "$PROFILE")"
# Kill only the Firefox processes using this throwaway profile.
powershell -NoProfile -Command '
  Get-CimInstance Win32_Process -Filter "Name=''firefox.exe''" |
    Where-Object { $_.CommandLine -like ("*" + $env:WP + "*") } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }' >/dev/null 2>&1
cat "$LOG"
grep -q "$SUITE DONE pass=[0-9]* fail=0" "$LOG"
