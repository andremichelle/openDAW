#!/usr/bin/env sh
# Build the wasm modules with the per-crate link flags the plugin model needs, then copy to public/.
#
#  - engine.wasm        the dynamic-linker host. Imports the shared linear memory (--import-memory) AND the
#                       shared function table (--import-table) so device side modules install their
#                       `process` into it and the engine calls them via call_indirect. Exports device_alloc
#                       / device_register for the worklet loader.
#  - device_*.wasm      PIC SIDE MODULES (-C relocation-model=pic, --experimental-pic -shared): each one's
#                       data base is assigned by the host loader at load (env.__memory_base), so any number
#                       of distinct devices coexist in the one shared memory with no fixed --global-base.
#                       Same shared-memory import as the engine.
#  - sine.wasm          the standalone step-1 sine page; its own memory, default build.
set -e
. "$HOME/.cargo/env"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/crates"
TARGET=wasm32-unknown-unknown
OUT="target/$TARGET/release"
MAX_MEMORY=4294967296 # 4 GiB = 65536 wasm pages, the wasm32 ceiling (address-space reservation, lazily committed)

# SHARED linear memory so the main thread can see the WASM heap. Importing a shared memory means the
# module must DECLARE a shared memory import (--shared-memory + --max-memory). We do NOT enable atomic
# instructions: the engine is single-threaded (only the audio thread runs wasm; the main thread only writes
# sample data into the heap), so we only need the shared FLAG, not atomic ops. --no-check-features skips
# wasm-ld's atomics/bulk-memory feature lint on precompiled core and the deps. Stays on stable, no build-std.
SHARED="-C link-arg=--shared-memory -C link-arg=--max-memory=$MAX_MEMORY -C link-arg=--no-check-features"
# PIC side module: data/table placed relative to host-assigned __memory_base / __table_base (dynamic
# linking). relocation-model=pic must reach EVERY object linked into the -shared module: the deps
# (libm/dsp, via RUSTFLAGS) AND core itself, which is precompiled non-PIC, so we rebuild it PIC with
# -Zbuild-std (nightly only). The engine + sine stay on stable; only the devices need nightly.
#  - panic=immediate-abort + default-visibility=hidden are ESSENTIAL: without them, -shared exports all of
#    core and --gc-sections cannot prune it -> a ~1158-function module needing 58 GOT entries (a full
#    dynamic linker to resolve). With them, only process/init/state_size are roots, core is pruned, and the
#    module is ~2 KB with NO GOT, so the worklet loader needs no GOT resolution.
PIC_RUSTFLAGS="-C relocation-model=pic -C link-arg=--experimental-pic -C link-arg=-shared $SHARED -Zunstable-options -Cpanic=immediate-abort -Zdefault-visibility=hidden"
DEVICE_TOOLCHAIN="${DEVICE_TOOLCHAIN:-nightly}"

# The PIC side-module device crates. ADD A NEW DEVICE HERE (its crate name) and it is built, size-optimised,
# and copied to public/ automatically. The wasm artifact basename is the crate name with '-' -> '_'.
DEVICE_CRATES="device-lowpass device-transpose device-arp device-zeitgeist device-tidal device-vaporisateur device-nano device-delay device-playfield-slot device-gate device-werkstatt device-apparat device-spielwerk device-waveshaper device-crusher device-fold device-stereo-tool device-velocity device-maximizer device-compressor device-reverb device-dattorro-reverb device-soundfont"

cargo rustc -p engine --release --target "$TARGET" -- \
  -C link-arg=--import-memory -C link-arg=--import-table $SHARED
for crate in $DEVICE_CRATES; do
  RUSTFLAGS="$PIC_RUSTFLAGS" cargo "+$DEVICE_TOOLCHAIN" build -p "$crate" --release --target "$TARGET" -Zbuild-std=core
done
cargo build -p sine --release --target "$TARGET"

# Module basenames (crate '-' -> '_') plus the engine host and the standalone sine.
DEVICE_MODULES=$(echo "$DEVICE_CRATES" | tr '-' '_')
MODULES="engine $DEVICE_MODULES sine"

# Size-optimise each module with binaryen's wasm-opt (Homebrew: `brew install binaryen`). GUARDED: if it is
# not installed the build still works, just larger. The devices are PIC side modules (a `dylink.0` section,
# imported PIC globals, a `__wasm_apply_data_relocs` export); wasm-opt understands side modules and preserves
# all of that. The memory is SHARED (no atomic ops), so it needs --enable-threads, plus Rust's bulk-memory /
# mutable-globals; a feature mismatch makes wasm-opt fail loudly (a safe, build-time error). After enabling
# this, verify the devices still load and play in the browser.
if command -v wasm-opt >/dev/null 2>&1; then
  for module in $MODULES; do
    wasm-opt -Oz --enable-threads --enable-bulk-memory --enable-mutable-globals \
      "$OUT/$module.wasm" -o "$OUT/$module.wasm.opt"
    mv "$OUT/$module.wasm.opt" "$OUT/$module.wasm"
  done
  echo "wasm-opt: optimised $MODULES"
else
  echo "wasm-opt not found (brew install binaryen) — shipping unoptimised modules"
fi

CP_LIST=""
for module in $MODULES; do CP_LIST="$CP_LIST $OUT/$module.wasm"; done
cp $CP_LIST "$ROOT/packages/app/wasm/public/"
echo "built: engine.wasm + stock devices + werkstatt/apparat/spielwerk + sine"
