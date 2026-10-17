#!/usr/bin/env bash
# Builds the test plugin and wraps it as "openDAW Test Synth.vst3" in target/; --install copies it to the user's VST3 folder
set -e
cd "$(dirname "$0")"
cargo build --release
name="openDAW Test Synth"
bundle="target/$name.vst3"
rm -rf "$bundle"
case "$(uname -s)" in
    Darwin)
        mkdir -p "$bundle/Contents/MacOS"
        cp target/release/libopendaw_test_plugin.dylib "$bundle/Contents/MacOS/$name"
        cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>$name</string>
<key>CFBundleIdentifier</key><string>studio.opendaw.test-synth</string>
<key>CFBundlePackageType</key><string>BNDL</string>
</dict></plist>
PLIST
        folder="$HOME/Library/Audio/Plug-Ins/VST3" ;;
    Linux)
        mkdir -p "$bundle/Contents/$(uname -m)-linux"
        cp target/release/libopendaw_test_plugin.so "$bundle/Contents/$(uname -m)-linux/$name.so"
        folder="$HOME/.vst3" ;;
    *)
        mkdir -p "$bundle/Contents/x86_64-win"
        cp target/release/opendaw_test_plugin.dll "$bundle/Contents/x86_64-win/$name.vst3"
        folder="" ;;
esac
echo "$bundle"
if [ "$1" = "--install" ] && [ -n "$folder" ]; then
    mkdir -p "$folder"
    rm -rf "$folder/$name.vst3"
    cp -R "$bundle" "$folder/"
    echo "installed in $folder"
fi
