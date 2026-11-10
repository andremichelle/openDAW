#!/usr/bin/env sh
# Test-only engine with the heap-guard allocator (crates/engine/src/heap_guard.rs) for the heap stress tests.
# Same link flags as build-wasm.sh, own target dir so the release engine stays untouched, no wasm-opt.
set -e
. "$(dirname "$0")/cargo-env.sh"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/crates"
TARGET=wasm32-unknown-unknown
GUARD_TARGET="$ROOT/crates/target/heap-guard"
CARGO_TARGET_DIR="$GUARD_TARGET" RUSTFLAGS="-C target-feature=+simd128" cargo rustc -p engine --release --target "$TARGET" \
  --features heap-guard -- -C link-arg=--import-memory -C link-arg=--import-table -C link-arg=--no-check-features
mkdir -p "$ROOT/packages/studio/core-wasm/dist/wasm-guard"
cp "$GUARD_TARGET/$TARGET/release/engine.wasm" "$ROOT/packages/studio/core-wasm/dist/wasm-guard/engine.wasm"
echo "built: dist/wasm-guard/engine.wasm (heap-guard)"
