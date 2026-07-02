import {describe, it} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {decodeBundle} from "../src/bundle"

describe.skipIf(!existsSync("/tmp/ambition.odb"))("ambition devices", () => {
    it("counts box types + samples", async () => {
        const buffer = readFileSync("/tmp/ambition.odb")
        const {boxGraph, samples} = await decodeBundle(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
        const counts = new Map<string, number>()
        for (const box of boxGraph.boxes()) {counts.set(box.name, (counts.get(box.name) ?? 0) + 1)}
        const interesting = [...counts].filter(([name]) => /Device|Soundfont|Nam|Neural|Script|Apparat|Werkstatt|Spielwerk|File/.test(name))
        console.log("DEVICES", JSON.stringify(Object.fromEntries(interesting.sort()), null, 0))
        console.log("SAMPLES", samples.length)
    }, 60000)
})
