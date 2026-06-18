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
MAX_MEMORY=4294967296 # 4 GiB = 65536 wasm pages, the wasm32 ceiling (address-space reservation, lazily committed)

# SHARED linear memory so the main thread can see the WASM heap. Importing a shared memory means the
# module must DECLARE a shared memory import (--shared-memory + --max-memory). We do NOT enable atomic
# instructions: the engine is single-threaded (only the audio thread runs wasm; the main thread only writes
# sample data into the heap), so we only need the shared FLAG, not atomic ops. --no-check-features skips
# wasm-ld's atomics/bulk-memory feature lint on precompiled core and the deps. Stays on stable, no build-std.
SHARED="-C link-arg=--shared-memory -C link-arg=--max-memory=$MAX_MEMORY -C link-arg=--no-check-features"

cargo rustc -p engine --release --target "$TARGET" -- -C link-arg=--import-memory $SHARED
cargo rustc -p device-sine --release --target "$TARGET" -- \
  -C link-arg=--import-memory \
  -C link-arg=--global-base=$DEVICE_BASE \
  -C link-arg=--export=__stack_pointer \
  $SHARED
cargo build -p sine --release --target "$TARGET"

cp "$OUT/engine.wasm" "$OUT/device_sine.wasm" "$OUT/sine.wasm" "$ROOT/packages/app/wasm/public/"
echo "built: engine.wasm device_sine.wasm sine.wasm"
