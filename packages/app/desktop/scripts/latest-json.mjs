// openDAW-latest.json for the app's updater (plans/shell-updates.md): per platform the signed file next to the
// installers, under {os}-{arch} and {os}-{arch}-{bundle}. Every installer platform must be signed, the deb is optional.
import {readdirSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {fileURLToPath} from "node:url"

const Platforms = [
    {file: "openDAW-macos-arm64.app.tar.gz", keys: ["darwin-aarch64", "darwin-aarch64-app"]},
    {file: "openDAW-macos-intel.app.tar.gz", keys: ["darwin-x86_64", "darwin-x86_64-app"]},
    {file: "openDAW-windows-setup.exe", keys: ["windows-x86_64", "windows-x86_64-nsis"]},
    {file: "openDAW-linux.AppImage", keys: ["linux-x86_64", "linux-x86_64-appimage"]},
    {file: "openDAW-linux-arm64.AppImage", keys: ["linux-aarch64", "linux-aarch64-appimage"]},
    {file: "openDAW-linux.deb", keys: ["linux-x86_64-deb"], optional: true},
    {file: "openDAW-linux-arm64.deb", keys: ["linux-aarch64-deb"], optional: true}
]

export const latestJson = (version, base, signatures) => {
    const platforms = {}
    for (const {file, keys, optional} of Platforms) {
        const signature = signatures[`${file}.sig`]
        if (signature === undefined) {
            if (optional) {continue}
            throw new Error(`${file} is not signed`)
        }
        for (const key of keys) {platforms[key] = {url: `${base}/${file}`, signature}}
    }
    return {version, platforms}
}

// node latest-json.mjs <folder> <version> <base url>: reads the .sig files in folder, writes openDAW-latest.json there
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [folder, version, base] = process.argv.slice(2)
    const signatures = Object.fromEntries(readdirSync(folder).filter(name => name.endsWith(".sig"))
        .map(name => [name, readFileSync(join(folder, name), "utf8").trim()]))
    writeFileSync(join(folder, "openDAW-latest.json"), JSON.stringify(latestJson(version, base, signatures), null, 2))
}
