#!/usr/bin/env sh
# The wasm DEV app's artifact refresh: the engine + device plugins are owned and built by
# @opendaw/studio-core-wasm (one source of truth). This script rebuilds them there, mirrors the package's
# dist/wasm into public/wasm/ for the dev server + tests, and adds the app-only standalone sine demo
# (its own memory, default build).
set -e
. "$HOME/.cargo/env"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
sh "$ROOT/packages/studio/core-wasm/build-wasm.sh"
cd "$ROOT/crates"
TARGET=wasm32-unknown-unknown
cargo build -p sine --release --target "$TARGET"
PUBLIC="$ROOT/packages/app/wasm/public"
rm -rf "$PUBLIC/wasm"
rm -f "$PUBLIC"/*.wasm
cp -R "$ROOT/packages/studio/core-wasm/dist/wasm" "$PUBLIC/wasm"
cp "target/$TARGET/release/sine.wasm" "$PUBLIC/wasm/"
echo "app-wasm: refreshed public/wasm from @opendaw/studio-core-wasm (+ sine)"
