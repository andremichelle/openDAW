// Checks that a built preset uses exactly the uploaded samples: npx tsx check.mts <stage dir>/<slug>
// Run it from ../opendaw-commons-main/tools, it reads the box headers with the commons Presets.scan.
import fs from "node:fs"
import path from "node:path"
import {Presets} from "../../../opendaw-commons-main/tools/src/Presets.ts"

const dir = path.resolve(process.argv[2])
const scanned = Presets.scan(new Uint8Array(fs.readFileSync(path.join(dir, "preset.odp"))))
if (!scanned.ok) {throw new Error(scanned.error)}
const expected: ReadonlyArray<string> = Object.values(JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8")))
const found = new Set(scanned.value.samples)
const matches = found.size === expected.length && expected.every(uuid => found.has(uuid))
console.log(found.size, matches)
if (!matches) {process.exit(1)}
