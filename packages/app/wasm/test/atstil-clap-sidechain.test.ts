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
// The feedback names "bar 33+": the third region (position 122880 = bar 33 at 960 ppqn, 140 bpm) starts at
// ~54.9 s. Render past it and assert on that span, where the clap pattern drives the pumping.
const QUANTA = 24375 // 65 s
const BAR_33_SECONDS = 55
const COMPRESSOR = "ac230f0c" // on the pads unit 69c7890a
const CLAP_PLAYFIELD = "de57cca4" // the clap Playfield DEVICE (a composite) on unit 7c5abdd4

const apply = (boxGraph: BoxGraph) => {
    const clap = boxGraph.boxes().find(box => UUID.toString(box.address.uuid).startsWith(CLAP_PLAYFIELD))
    for (const box of boxGraph.boxes()) {
        const id = UUID.toString(box.address.uuid)
        if (id.startsWith(COMPRESSOR)) {
            const compressor = box as unknown as {
                sideChain: {refer(target: unknown): void}, automakeup: {setValue(value: boolean): void}
                threshold: {setValue(value: number): void}
            }
            compressor.sideChain.refer(clap)
            compressor.automakeup.setValue(true)
            // Low enough that the raw clap mix clearly crosses it: the tap point (raw device vs strip) decides
            // whether the compressor ducks at all, so a wrong tap cannot hide behind an idle detector.
            compressor.threshold.setValue(-40.0)
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
        const seconds = Math.floor(QUANTA * 128 / 48000)
        const bar33From = BAR_33_SECONDS * 48000 * 2
        const tsRms = rmsOf(ts.buffer, bar33From), wasmRms = rmsOf(wasm, bar33From)
        const lines = [`bar 33+: ts ${tsRms.toExponential(3)} wasm ${wasmRms.toExponential(3)} delta ${(20 * Math.log10(wasmRms / tsRms)).toFixed(2)} dB`]
        // The pumping is transient (reduction + auto-makeup around each clap), so a long aggregate hides it —
        // assert per-second windows (the un-fixed strip tap diverges by ~11 dB in single windows).
        const deltas: number[] = []
        for (let second = 0; second < seconds; second++) {
            const from = second * 48000 * 2, to = (second + 1) * 48000 * 2
            const tsWindow = rmsOf(ts.buffer, from, to), wasmWindow = rmsOf(wasm, from, to)
            if (tsWindow > 1e-5 && wasmWindow > 1e-5) {
                const delta = 20 * Math.log10(wasmWindow / tsWindow)
                deltas.push(Math.abs(delta))
                lines.push(`  [${second}s] delta ${delta.toFixed(2)} dB`)
            }
        }
        writeFileSync("/tmp/atstil-clap-sidechain.txt", lines.join("\n") + "\n")
        console.log(lines.join("\n"))
        expect(tsRms).toBeGreaterThan(1e-4)
        expect(Math.abs(20 * Math.log10(wasmRms / tsRms))).toBeLessThan(0.5)
        expect(Math.max(...deltas), "worst per-second window").toBeLessThan(0.5)
    }, 300000)
})
