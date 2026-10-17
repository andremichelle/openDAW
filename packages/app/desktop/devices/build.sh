#!/usr/bin/env sh
# Desktop-only engine devices, same PIC side-module flags as packages/studio/core-wasm/build-wasm.sh
set -e
. "$(dirname "$0")/../../../studio/core-wasm/cargo-env.sh"
cd "$(dirname "$0")"
TARGET=wasm32-unknown-unknown
FLAGS="-C relocation-model=pic -C target-feature=+simd128 -C link-arg=--experimental-pic -C link-arg=-shared -C link-arg=--no-check-features -Zunstable-options -Cpanic=immediate-abort -Zdefault-visibility=hidden"
CRATES="device-native-instrument device-native-effect"
for crate in $CRATES; do
  RUSTFLAGS="$FLAGS" cargo "+${DEVICE_TOOLCHAIN:-nightly}" build -p "$crate" --release --target "$TARGET" -Zbuild-std=core
done
mkdir -p dist
for module in $(echo "$CRATES" | tr '-' '_'); do
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -O3 --enable-bulk-memory --enable-mutable-globals --enable-simd --enable-sign-ext \
      --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types \
      "target/$TARGET/release/$module.wasm" -o "dist/$module.wasm"
  else
    cp "target/$TARGET/release/$module.wasm" "dist/"
  fi
done
echo "built: $(ls dist)"
