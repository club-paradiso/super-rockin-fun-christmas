#!/bin/bash
# STUDIO SHALOM - restore the hub from the USB backup (macOS). Double-click in Finder.
cd "$(dirname "$0")/.." || exit 1
read -r -p "USB backup folder, e.g. /Volumes/FTL-BACKUP (USB 백업 폴더): " BACKUP
node scripts/hub-restore.mjs "$BACKUP"
read -r -p "Press Enter to close."
