#!/bin/bash
# STUDIO SHALOM - after the event: what is still on this laptop and the USB (macOS, read-only).
cd "$(dirname "$0")/.." || exit 1
node scripts/event-check.mjs
read -r -p "Press Enter to close."
