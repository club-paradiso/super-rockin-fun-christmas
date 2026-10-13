#!/bin/bash
# FOLLOW THE LIGHTS - media wall screen (macOS). Double-click in Finder.
# Needs only Chrome or Edge. The hub address is the first line of wall-hub.txt next to this file
# (shown in the hub window). If the browser closes or crashes it is opened again.
DIR="$(cd "$(dirname "$0")" && pwd)"
HUB="$(head -n 1 "$DIR/wall-hub.txt" | tr -d '\r')"
PROFILE="$HOME/Library/Application Support/follow-the-lights/wall"
BROWSER=""
for B in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
  if [ -z "$BROWSER" ] && [ -x "$B" ]; then BROWSER="$B"; fi
done
if [ -z "$BROWSER" ]; then
  echo "Chrome or Edge not found. (Chrome 또는 Edge 가 없어요.)"
  read -r -p "Press Enter to close."
  exit 1
fi
while true; do
  echo "Opening $HUB/wall"
  STARTED=$(date +%s)
  "$BROWSER" --user-data-dir="$PROFILE" --kiosk --app="$HUB/wall" --no-first-run \
    --no-default-browser-check --disable-session-crashed-bubble --disable-features=Translate \
    --autoplay-policy=no-user-gesture-required
  # Back within 10 s: another wall window already holds this profile (Chrome handed the launch
  # to it). Stop instead of stacking windows.
  if [ $(( $(date +%s) - STARTED )) -lt 10 ]; then
    echo "The wall screen is already open (or the browser could not start). This window can be closed."
    echo "(미디어월 화면이 이미 떠 있어요. 이 창은 닫아도 돼요.)"
    exit 0
  fi
  echo "The wall browser closed. Opening again in 5 seconds. Close this window to stop."
  sleep 5
done
