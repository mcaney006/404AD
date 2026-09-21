#!/usr/bin/env bash
# Compile the filter lists into the extension's runtime artifacts.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo run --release -q -p fad-compiler -- build --lists lists --out packages/extension/public "$@"
