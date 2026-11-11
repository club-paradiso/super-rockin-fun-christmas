#!/bin/bash
# STUDIO SHALOM - hub + booth screen (macOS). Double-click in Finder.
# Keep this window open while the event runs. Closing it stops the hub.
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Ask the tech lead. (Node.js 가 설치되지 않았어요.)"
  read -r -p "Press Enter to close."
  exit 1
fi
node scripts/hub-start.mjs "$@"
echo
echo "The hub has stopped. (허브가 꺼졌어요.)"
read -r -p "Press Enter to close."
