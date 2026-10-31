#!/usr/bin/env sh
# Builds the GPL-3.0 crates into dist/: matchering.wasm (the analysis, a standalone worker module) and
# device_mastering.wasm (the engine device, a PIC side module with the flags of core-wasm/build-wasm.sh).
# Kept out of core-wasm so the SDK never ships them.
set -e
. "$(dirname "$0")/../core-wasm/cargo-env.sh"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIST="$(cd "$(dirname "$0")" && pwd)/dist"
cd "$ROOT/crates"
TARGET=wasm32-unknown-unknown
OUT="target/$TARGET/release"
SIMD="-C target-feature=+simd128"
PIC_RUSTFLAGS="-C relocation-model=pic $SIMD -C link-arg=--experimental-pic -C link-arg=-shared -C link-arg=--no-check-features -Zunstable-options -Cpanic=immediate-abort -Zdefault-visibility=hidden"
RUSTFLAGS="$SIMD" cargo build -p matchering --release --target "$TARGET"
RUSTFLAGS="$PIC_RUSTFLAGS" cargo "+${DEVICE_TOOLCHAIN:-nightly}" build -p device-mastering --release --target "$TARGET" -Zbuild-std=core
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-mutable-globals --enable-simd \
    --enable-sign-ext --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types \
    "$OUT/device_mastering.wasm" -o "$OUT/device_mastering.wasm.opt.$$"
  mv "$OUT/device_mastering.wasm.opt.$$" "$OUT/device_mastering.wasm"
fi
mkdir -p "$DIST"
cp "$OUT/matchering.wasm" "$OUT/device_mastering.wasm" "$DIST/"
echo "built: matchering.wasm + device_mastering.wasm"
