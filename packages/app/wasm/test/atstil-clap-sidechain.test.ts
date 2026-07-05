// Regression for the atstil feedback "the sidechain makes the audio LOUDER (pads pump up when the clap plays);
// disabling auto-makeup fixes it": the pads' compressor sidechained to the CLAP — a Playfield, i.e. a COMPOSITE
// device. TS resolves the composite device address to its raw pad-mix output (`MixProcessor` registers
// `adapter.address -> output`, pre the unit's fx + strip). The wasm engine never registered the composite device
// uuid, so the sidechain fell back to the clap UNIT's strip output (post Waveshaper, post +3.57 dB fader, post
// MUTE) — a hotter (or, muted, silent) detection signal, so the compressor and its auto-makeup pump differently
// than TS. The clap unit is MUTED here to sharpen the tap point: TS still ducks (raw device tap), a strip tap
// hears silence and never ducks.
import * as path from "node:path"
import {describe, expect, it} from "vitest"
import {existsSync, writeFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {buildSampleMap, renderTs} from "./helpers/render-ts"
import {decodeAtstil, fetchAtstilSamples, registerAtstilScripts, renderAtstilWasm, rmsOf} from "./helpers/atstil"

const FILE = path.resolve(__dirname, "../../../../test-files/atstil.od")
const QUANTA = 3750 // 10 s
const COMPRESSOR = "ac230f0c" // on the pads unit 69c7890a
const CLAP_PLAYFIELD = "de57cca4" // the clap Playfield DEVICE (a composite) on unit 7c5abdd4

const apply = (boxGraph: BoxGraph) => {
    const clap = boxGraph.boxes().find(box => UUID.toString(box.address.uuid).startsWith(CLAP_PLAYFIELD))
    for (const box of boxGraph.boxes()) {
        const id = UUID.toString(box.address.uuid)
        if (id.startsWith(COMPRESSOR)) {
            const compressor = box as unknown as {
                sideChain: {refer(target: unknown): void}, automakeup: {setValue(value: boolean): void}
            }
            compressor.sideChain.refer(clap)
            compressor.automakeup.setValue(true)
        }
        if (box.name === "AudioUnitBox" && !id.startsWith("69c7890a")) {
            const unit = box as unknown as {type: {getValue(): string}, mute: {setValue(value: boolean): void}}
            if (unit.type.getValue() === "instrument") {unit.mute.setValue(true)}
        }
    }
}

describe.skipIf(!existsSync(FILE))("atstil clap sidechain", () => {
    it("the pads' compressor sidechained to the clap Playfield matches TS", async () => {
        const samples = await fetchAtstilSamples(decodeAtstil())
        const graphTs = decodeAtstil()
        registerAtstilScripts(graphTs)
        graphTs.beginTransaction(); apply(graphTs); graphTs.endTransaction()
        const ts = await renderTs(ProjectSkeleton.encode(graphTs), buildSampleMap(samples), QUANTA)
        const graphWasm = decodeAtstil()
        registerAtstilScripts(graphWasm)
        graphWasm.beginTransaction(); apply(graphWasm); graphWasm.endTransaction()
        const wasm = await renderAtstilWasm(graphWasm, samples, QUANTA)
        const tsRms = rmsOf(ts.buffer), wasmRms = rmsOf(wasm)
        const lines = [`total: ts ${tsRms.toExponential(3)} wasm ${wasmRms.toExponential(3)} delta ${(20 * Math.log10(wasmRms / tsRms)).toFixed(2)} dB`]
        for (let second = 0; second < 10; second++) {
            const from = second * 48000 * 2, to = (second + 1) * 48000 * 2
            const tsWindow = rmsOf(ts.buffer, from, to), wasmWindow = rmsOf(wasm, from, to)
            if (tsWindow > 1e-7 && wasmWindow > 1e-7) {
                lines.push(`  [${second}s] delta ${(20 * Math.log10(wasmWindow / tsWindow)).toFixed(2)} dB`)
            }
        }
        writeFileSync("/tmp/atstil-clap-sidechain.txt", lines.join("\n") + "\n")
        console.log(lines.join("\n"))
        expect(tsRms).toBeGreaterThan(1e-4)
        expect(Math.abs(20 * Math.log10(wasmRms / tsRms))).toBeLessThan(0.5)
    }, 300000)
})
