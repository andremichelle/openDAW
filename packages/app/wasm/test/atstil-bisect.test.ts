// Bisect for the atstil.od TS-vs-wasm level divergence (~-8 dB on BOTH units): solo the SIMPLE unit
// (7c5abdd4 = Playfield "clap track" -> Waveshaper) and toggle its devices to localize the divergent stage.
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

type Tweak = {label: string, apply: (boxGraph: BoxGraph) => void}

const setEnabled = (boxGraph: BoxGraph, prefix: string, enabled: boolean) => {
    for (const box of boxGraph.boxes()) {
        if (!UUID.toString(box.address.uuid).startsWith(prefix)) {continue}
        (box as unknown as {enabled: {setValue(value: boolean): void}}).enabled.setValue(enabled)
    }
}

const muteAllBut = (boxGraph: BoxGraph, keep: string) => {
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioUnitBox") {continue}
        const unit = box as unknown as {type: {getValue(): string}, mute: {setValue(value: boolean): void}}
        if (unit.type.getValue() === "instrument" && !UUID.toString(box.address.uuid).startsWith(keep)) {unit.mute.setValue(true)}
    }
}

describe.skipIf(!existsSync(FILE))("atstil bisect", () => {
    it("localizes the divergent stage", async () => {
        const samples = await fetchAtstilSamples(decodeAtstil())
        const chain: Array<[string, string]> = [
            ["3bac3b0f", "Werkstatt A"], ["9605fa26", "Werkstatt B"], ["e83cc48c", "Ring Modulator"],
            ["f4b67377", "Werkstatt C"], ["6de581c7", "Revamp"], ["9ff546b6", "Delay"],
            ["a2ddddc5", "Waveshaper"], ["ac230f0c", "Compressor"], ["6d976221", "pad StereoTool"]
        ]
        const setFloat = (boxGraph: BoxGraph, prefix: string, key: number, value: number) => {
            for (const box of boxGraph.boxes()) {
                if (!UUID.toString(box.address.uuid).startsWith(prefix)) {continue}
                (box as unknown as {getField(key: number): {setValue(value: number): void}}).getField(key).setValue(value)
            }
        }
        const allOffExcept = (boxGraph: BoxGraph, keep: string) => {
            muteAllBut(boxGraph, "69c7890a")
            for (const [id] of chain) {
                if (id !== keep) {setEnabled(boxGraph, id, false)}
            }
        }
        const soloPadViaMute = (boxGraph: BoxGraph, keep: string) => {
            for (const box of boxGraph.boxes()) {
                if (box.name !== "PlayfieldSampleBox") {continue}
                if (!UUID.toString(box.address.uuid).startsWith(keep)) {
                    (box as unknown as {mute: {setValue(value: boolean): void}}).mute.setValue(true)
                }
            }
        }
        const pads: Array<[string, string]> = [
            ["63266b39", "bass drum (StereoTool)"], ["5d0ed87a", "bass click (sampleEnd 0.01)"],
            ["ac99617f", "snare"], ["47ecbfcf", "closed hat"], ["699d5cc8", "open hat"], ["7a946cbd", "cymbal"]
        ]
        const tweaks: Tweak[] = pads.map(([id, name]): Tweak => ({
            label: `pad ${name}, unit fx OFF`,
            apply: boxGraph => {allOffExcept(boxGraph, "6d976221"); soloPadViaMute(boxGraph, id)}
        }))
        const lines: string[] = []
        for (const {label, apply} of tweaks) {
            const graphTs = decodeAtstil()
            registerAtstilScripts(graphTs)
            graphTs.beginTransaction(); apply(graphTs); graphTs.endTransaction()
            const ts = await renderTs(ProjectSkeleton.encode(graphTs), buildSampleMap(samples), QUANTA)
            const graphWasm = decodeAtstil()
            registerAtstilScripts(graphWasm)
            graphWasm.beginTransaction(); apply(graphWasm); graphWasm.endTransaction()
            const wasm = await renderAtstilWasm(graphWasm, samples, QUANTA)
            const tsRms = rmsOf(ts.buffer), wasmRms = rmsOf(wasm)
            const delta = tsRms > 1e-7 && wasmRms > 1e-7 ? `${(20 * Math.log10(wasmRms / tsRms)).toFixed(2)} dB` : "silent"
            lines.push(`${label}: ${delta} (ts ${tsRms.toExponential(3)}, wasm ${wasmRms.toExponential(3)})`)
        }
        writeFileSync("/tmp/atstil-bisect.txt", lines.join("\n") + "\n")
        console.log(lines.join("\n"))
        expect(lines.length).toBe(tweaks.length)
    }, 600000)
})
