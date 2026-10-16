#!/usr/bin/env bash
# Builds the native engine for the bundle's target and places it where Tauri's externalBin expects it
set -e
cd "$(dirname "$0")/.."
triple="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
mkdir -p binaries
host="$(rustc -vV | sed -n 's/^host: //p')"
# prints the path of the built engine; the host architecture reuses the plain release build
build() {
    if [ "$1" = "$host" ]; then
        cargo build --release --manifest-path engine/Cargo.toml >&2
        echo "engine/target/release/opendaw-engine"
    else
        cargo build --release --manifest-path engine/Cargo.toml --target "$1" >&2
        echo "engine/target/$1/release/opendaw-engine"
    fi
}
if [ "$triple" = "universal-apple-darwin" ]; then
    arm="$(build aarch64-apple-darwin)"
    intel="$(build x86_64-apple-darwin)"
    lipo -create -output binaries/opendaw-engine-universal-apple-darwin "$arm" "$intel"
else
    suffix=""
    case "$triple" in *windows*) suffix=".exe" ;; esac
    cp "$(build "$triple")$suffix" "binaries/opendaw-engine-$triple$suffix"
fi
