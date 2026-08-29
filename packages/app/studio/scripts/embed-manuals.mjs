import {cpSync, existsSync} from "node:fs"
import {resolve} from "node:path"

const src = resolve(import.meta.dirname, "../../manual/dist")
const dest = resolve(import.meta.dirname, "../dist/manuals")
if (!existsSync(src)) {
    console.error("embed-manuals: @opendaw/manual dist is missing. Build it first.")
    process.exit(1)
}
cpSync(src, dest, {recursive: true})
console.debug(`embed-manuals: copied ${src} -> ${dest}`)
