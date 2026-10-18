import {test} from "node:test"
import assert from "node:assert/strict"
import {latestJson} from "./latest-json.mjs"

const base = "https://dev.opendaw.studio/install"

test("each platform points at its signed file, the deb only where it is signed", () => {
    const files = {
        "openDAW-macos-arm64.app.tar.gz.sig": "mac-arm", "openDAW-macos-intel.app.tar.gz.sig": "mac-intel",
        "openDAW-windows-setup.exe.sig": "win", "openDAW-linux.AppImage.sig": "linux-app", "openDAW-linux.deb.sig": "linux-deb",
        "openDAW-linux-arm64.AppImage.sig": "arm-app"
    }
    const json = latestJson("0.0.17", base, files)
    assert.equal(json.version, "0.0.17")
    assert.deepEqual(json.platforms["darwin-aarch64"], {url: `${base}/openDAW-macos-arm64.app.tar.gz`, signature: "mac-arm"})
    assert.deepEqual(json.platforms["darwin-aarch64-app"], json.platforms["darwin-aarch64"])
    assert.deepEqual(json.platforms["darwin-x86_64"], {url: `${base}/openDAW-macos-intel.app.tar.gz`, signature: "mac-intel"})
    assert.deepEqual(json.platforms["windows-x86_64-nsis"], {url: `${base}/openDAW-windows-setup.exe`, signature: "win"})
    assert.deepEqual(json.platforms["linux-x86_64"], {url: `${base}/openDAW-linux.AppImage`, signature: "linux-app"})
    assert.deepEqual(json.platforms["linux-x86_64-appimage"], json.platforms["linux-x86_64"])
    assert.deepEqual(json.platforms["linux-x86_64-deb"], {url: `${base}/openDAW-linux.deb`, signature: "linux-deb"})
    assert.deepEqual(json.platforms["linux-aarch64"], {url: `${base}/openDAW-linux-arm64.AppImage`, signature: "arm-app"})
    assert.equal(json.platforms["linux-aarch64-deb"], undefined, "an unsigned deb is left out")
})

test("a missing platform fails, a release never goes out half signed", () => {
    assert.throws(() => latestJson("0.0.17", base, {"openDAW-windows-setup.exe.sig": "win"}), /macos-arm64/)
})
