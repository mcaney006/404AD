#!/usr/bin/env bash
# Run a fuzz target.
#
#   scripts/fuzz.sh parse_line [-- libfuzzer args]
#
# Targets: parse_line, compile_list, cosmetic_index, sabr_stream
#
# cargo-fuzz needs a nightly toolchain for the sanitizer instrumentation, which
# is why the fuzz crate is excluded from the workspace: a stable `cargo test
# --workspace` must not try to build it.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-parse_line}"
shift || true

if ! command -v cargo-fuzz >/dev/null 2>&1; then
  echo "error: cargo-fuzz is not installed. run: cargo install cargo-fuzz" >&2
  exit 1
fi
if ! rustup toolchain list 2>/dev/null | grep -q nightly; then
  echo "error: cargo-fuzz requires a nightly toolchain. run: rustup toolchain install nightly" >&2
  exit 1
fi

exec cargo +nightly fuzz run "$TARGET" "$@"
