#!/usr/bin/env sh
# A/B: runs Matchering 2.0.6 and openDAW's port on the same two 44.1 kHz WAV files, writes all results into the
# output folder and prints the differences. PYTHON may point at an interpreter with matchering installed.
# Usage: sh crates/device-mastering/tools/compare.sh target.wav reference.wav [out-folder]
set -e
TARGET="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
REFERENCE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
OUT="${3:-matchering-compare}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
"${PYTHON:-python3}" -I "$HERE/compare.py" "$TARGET" "$REFERENCE" "$OUT"
. "$HERE/../../../packages/studio/core-wasm/cargo-env.sh"
cd "$HERE/../.."
cargo run --quiet --release -p device-mastering --example compare -- "$TARGET" "$REFERENCE" "$OUT"
