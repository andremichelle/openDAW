import {readdir, readFile} from "node:fs/promises"
import {resolve, relative} from "node:path"
import assert from "node:assert/strict"

const [mode, directory = "packages/app/studio/dist"] = process.argv.slice(2)
assert(["enabled", "disabled"].includes(mode), "Usage: node check-muscriptor-build.mjs enabled|disabled [dist]")
const root = resolve(directory)
const walk = async path => (await Promise.all((await readdir(path, {withFileTypes: true})).map(async entry =>
    entry.isDirectory() ? walk(resolve(path, entry.name)) : [resolve(path, entry.name)]))).flat()
const files = await walk(root)
const workers = files.filter(file => /muscriptor\.worker.*\.js$/.test(file))
const scripts = files.filter(file => /\.js(?:\.map)?$/.test(file))
const matches = []
for (const file of scripts) {
    const text = await readFile(file, "utf8")
    if (/cursedhelm\/cubaser-muscriptor|18b368334ddaeafed4446377eb7d0b63d14ccc1f|Convert Instruments to MIDI/.test(text)) {
        matches.push(relative(root, file))
    }
}
if (mode === "disabled") {
    assert.equal(workers.length, 0, "Disabled build emitted a MuScriptor worker")
    assert.deepEqual(matches, [], "Disabled build contains model URLs, metadata or conversion controls")
} else {
    assert(workers.length > 0, "Enabled build has no MuScriptor worker")
    assert(matches.length > 0, "Enabled build has no MuScriptor integration")
}
console.log(`MuScriptor ${mode} build verified: ${scripts.length} scripts/maps, ${workers.length} model workers.`)
