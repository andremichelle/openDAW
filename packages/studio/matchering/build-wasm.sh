#!/usr/bin/env sh
# Builds crates/matchering (GPL-3.0) into dist/matchering.wasm. Kept out of core-wasm so the SDK never ships it.
set -e
. "$(dirname "$0")/../core-wasm/cargo-env.sh"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIST="$(cd "$(dirname "$0")" && pwd)/dist"
cd "$ROOT/crates"
RUSTFLAGS="-C target-feature=+simd128" cargo build -p matchering --release --target wasm32-unknown-unknown
mkdir -p "$DIST"
cp target/wasm32-unknown-unknown/release/matchering.wasm "$DIST/matchering.wasm"
echo "built: matchering.wasm"
