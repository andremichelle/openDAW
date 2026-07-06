// The AudioWorkletGlobalScope provides NEITHER TextDecoder NOR TextEncoder (see src/worklet-scope.ts for
// what the shim covers: only `self` / `location`). Node-run vitest never catches such a gap (node has
// both), and one module-scope construction kills the whole worklet before `registerProcessor` runs — so
// this guard greps every worklet-reachable source tree for the two constructors (use src/utf8.ts instead).
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readdirSync, readFileSync} from "node:fs"

const TREES = [
    path.resolve(__dirname, "../src"),
    path.resolve(__dirname, "../../../studio/core-wasm/src")
]

const collect = (dir: string, out: Array<string>): Array<string> => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {collect(full, out)} else if (entry.name.endsWith(".ts")) {out.push(full)}
    }
    return out
}

describe("worklet scope guard", () => {
    it("no worklet-reachable source constructs TextDecoder or TextEncoder", () => {
        const offenders: Array<string> = []
        for (const tree of TREES) {
            for (const file of collect(tree, [])) {
                const source = readFileSync(file, "utf8")
                if (/new\s+Text(Decoder|Encoder)\s*\(/.test(source)) {offenders.push(file)}
            }
        }
        expect(offenders, "use src/utf8.ts decodeUtf8 (no TextDecoder in the AudioWorkletGlobalScope)").toEqual([])
    })
})
