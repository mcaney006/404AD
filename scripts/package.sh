#!/usr/bin/env bash
# Copy the built extension to its deterministic load path.
#
#   dist/404ad-chrome-mv3/
#
# That is the directory to point chrome://extensions -> Load unpacked at. It is
# a plain copy of .output/chrome-mv3 so the two can never disagree.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=packages/extension/.output/chrome-mv3
DEST=dist/404ad-chrome-mv3

if [ ! -f "$SRC/manifest.json" ]; then
  echo "error: $SRC/manifest.json not found. Run \`bun run build:extension\` first." >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$SRC" "$DEST"

FILES=$(find "$DEST" -type f | wc -l | tr -d ' ')
BYTES=$(find "$DEST" -type f -exec cat {} + | wc -c | tr -d ' ')
printf '==> packaged %s files (%s bytes) at %s\n' "$FILES" "$BYTES" "$DEST"
printf '    load it with: chrome://extensions -> Developer mode -> Load unpacked -> %s\n' "$PWD/$DEST"
