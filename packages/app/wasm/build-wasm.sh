#!/usr/bin/env sh
# Build the wasm modules with the per-crate link flags the plugin model needs, then copy to public/.
#
#  - engine.wasm        imports the shared linear memory (--import-memory); reserves a talc-excluded
#                       address-space window for device read-only data (a .bss static in the engine).
#  - device_sine.wasm   imports the shared memory; its read-only data is relocated into the reserved
#                       window (--global-base=DEVICE_BASE); its stack pointer is exported so the host
#                       can point it at an engine-(talc-)allocated stack. Everything else the device
#                       uses is allocated by the engine's talc and passed in the descriptor (zero-copy).
#  - sine.wasm          the standalone step-1 sine page; its own memory, default build.
set -e
. "$HOME/.cargo/env"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/crates"
TARGET=wasm32-unknown-unknown
OUT="target/$TARGET/release"
DEVICE_BASE=4194304 # 4 MiB: above the engine's static data, inside its reserved window, below the talc heap

cargo rustc -p engine --release --target "$TARGET" -- -C link-arg=--import-memory
cargo rustc -p device-sine --release --target "$TARGET" -- \
  -C link-arg=--import-memory \
  -C link-arg=--global-base=$DEVICE_BASE \
  -C link-arg=--export=__stack_pointer
cargo build -p sine --release --target "$TARGET"

cp "$OUT/engine.wasm" "$OUT/device_sine.wasm" "$OUT/sine.wasm" "$ROOT/packages/app/wasm/public/"
echo "built: engine.wasm device_sine.wasm sine.wasm"
