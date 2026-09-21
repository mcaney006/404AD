#!/usr/bin/env bash
# Build the 404AD WASM runtime and place its artifacts where the extension
# build expects them.
#
#   JS glue  -> packages/extension/src/wasm/     (bundled by Vite)
#   .wasm    -> packages/extension/public/wasm/  (web-accessible, loaded by URL)
#
# The binary is fetched at runtime from chrome.runtime.getURL, so it is always
# packaged locally. 404AD never loads executable code from the network.
set -euo pipefail

cd "$(dirname "$0")/.."

# Homebrew's cargo has no wasm32 target; rustup's does. Prefer whichever can
# actually build for wasm rather than whichever happens to be first on PATH.
if [ -x "$HOME/.cargo/bin/rustup" ] && "$HOME/.cargo/bin/rustup" target list --installed | grep -qx wasm32-unknown-unknown; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if ! rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then
  echo "error: the wasm32-unknown-unknown target is not installed." >&2
  echo "       run: rustup target add wasm32-unknown-unknown" >&2
  exit 1
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack is not installed. run: cargo install wasm-pack" >&2
  exit 1
fi

echo "==> building fad-wasm"
wasm-pack build crates/fad-wasm \
  --target web \
  --release \
  --out-dir pkg \
  --out-name fad_wasm \
  --no-pack

GLUE_DIR=packages/extension/src/wasm
WASM_DIR=packages/extension/public/wasm
rm -rf "$GLUE_DIR" "$WASM_DIR"
mkdir -p "$GLUE_DIR" "$WASM_DIR"

# wasm-bindgen's glue falls back to `new URL('fad_wasm_bg.wasm', import.meta.url)`
# when no path is given. 404AD always passes an explicit chrome-extension:// URL,
# so that branch is dead code -- but the bundler still tries to resolve it and
# warns. Neutralise the literal so the build output stays clean.
sed "s|new URL('fad_wasm_bg.wasm', import.meta.url)|(() => { throw new Error('404AD: pass module_or_path explicitly'); })()|" \
  crates/fad-wasm/pkg/fad_wasm.js > "$GLUE_DIR/fad_wasm.js"
cp crates/fad-wasm/pkg/fad_wasm.d.ts    "$GLUE_DIR/"
cp crates/fad-wasm/pkg/fad_wasm_bg.wasm "$WASM_DIR/"
if [ -f crates/fad-wasm/pkg/fad_wasm_bg.wasm.d.ts ]; then
  cp crates/fad-wasm/pkg/fad_wasm_bg.wasm.d.ts "$GLUE_DIR/"
fi

printf '==> wasm runtime: %s bytes\n' "$(wc -c < "$WASM_DIR/fad_wasm_bg.wasm" | tr -d ' ')"
