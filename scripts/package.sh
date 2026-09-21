#!/usr/bin/env bash
# Copy the built extension to its deterministic load path, and archive it.
#
#   dist/404ad-chrome-mv3/               <- chrome://extensions -> Load unpacked
#   dist/404ad-chrome-mv3-<version>.zip  <- upload / hand to someone
#
# The directory is a plain copy of .output/chrome-mv3 so the two can never
# disagree, and the archive is a plain zip of the directory so all three agree.
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

# The manifest must actually declare its rulesets, and every path it names
# must be there. `wxt.config.ts` warns and carries on when the compiled rules
# are missing, so that preparing types does not require building them; this is
# the check that turns that warning into a failure at the point it matters.
DECLARED=$(grep -o '"path":"rules/[^"]*"' "$DEST/manifest.json" | sed 's/.*"rules/rules/;s/"$//' | sort -u)
if [ -z "$DECLARED" ]; then
  echo "error: $DEST/manifest.json declares no rulesets. Run \`bun run build:filters\` first." >&2
  exit 1
fi
for RULESET in $DECLARED; do
  if [ ! -f "$DEST/$RULESET" ]; then
    echo "error: manifest declares $RULESET but it is not in the package." >&2
    exit 1
  fi
done

FILES=$(find "$DEST" -type f | wc -l | tr -d ' ')
BYTES=$(find "$DEST" -type f -exec cat {} + | wc -c | tr -d ' ')

# The compiler already proves two builds of the same lists produce identical
# artifacts. An archive whose checksum moved every time would throw that away,
# so entries go in sorted order with a fixed timestamp and no extra attributes:
# same input, same zip, same hash.
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DEST/manifest.json" | head -1)
ZIP="dist/404ad-chrome-mv3-${VERSION}.zip"

rm -f "$ZIP"
find "$DEST" -exec touch -t 198001010000.00 {} +
(cd "$DEST" && find . -type f | LC_ALL=C sort | sed 's|^\./||' | zip -q -X -@ "../$(basename "$ZIP")")

if command -v shasum >/dev/null 2>&1; then
  DIGEST=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
else
  DIGEST=$(sha256sum "$ZIP" | cut -d' ' -f1)
fi
ZIP_BYTES=$(wc -c < "$ZIP" | tr -d ' ')

printf '==> packaged %s files (%s bytes) at %s\n' "$FILES" "$BYTES" "$DEST"
printf '    load it with: chrome://extensions -> Developer mode -> Load unpacked -> %s\n' "$PWD/$DEST"
printf '==> archive %s (%s bytes)\n' "$ZIP" "$ZIP_BYTES"
printf '    sha256 %s\n' "$DIGEST"
