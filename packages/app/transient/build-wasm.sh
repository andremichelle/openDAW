#!/usr/bin/env bash
# Build the stretch-wasm transient detector and copy it into this app's public/ dir.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/crates"
cargo build -p stretch-wasm --release --target wasm32-unknown-unknown
mkdir -p "$ROOT/packages/app/transient/public"
cp target/wasm32-unknown-unknown/release/stretch_wasm.wasm \
   "$ROOT/packages/app/transient/public/stretch_wasm.wasm"
echo "copied stretch_wasm.wasm -> packages/app/transient/public/"
