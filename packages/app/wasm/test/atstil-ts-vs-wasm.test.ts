// TS-vs-wasm comparison for "~/Downloads/atstil.od" (user: "sounds very(!) different"). Fetches the project's
// stock samples from assets.opendaw.studio (cached in /tmp/atstil-samples), renders both engines with identical
// PCM, and reports full-mix / per-second-window / per-soloed-unit RMS deltas to localize the divergence.
import * as path from "node:path"
import {describe, expect, it} from "vitest"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildSampleMap, renderTs} from "./helpers/render-ts"

const FILE = path.resolve(__dirname, "../../../../test-files/atstil.od")
const CACHE = "/tmp/atstil-samples"
const QUANTA = 11250 // 30 s at 48 kHz / 128 frames

const decode = () => {
    const buffer = readFileSync(FILE)
    return ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).boxGraph
}

const registerScripts = (boxGraph: BoxGraph): number => {
    let count = 0
    for (const box of boxGraph.boxes()) {
        if (!(box instanceof WerkstattDeviceBox)) {continue}
        const code = (box as unknown as {code: {getValue(): string}}).code.getValue()
        const match = code.match(/^\/\/ @\w+ js \d+ (\d+)\n/)
        if (match === null) {continue}
        new Function(ScriptCompiler.wrap(
            {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"},
            UUID.toString(box.address.uuid), parseInt(match[1]), code.slice(match[0].length)))()
        count++
    }
    return count
}

const fetchSamples = async (boxGraph: BoxGraph): Promise<Array<{uuid: UUID.Bytes, wav: ArrayBuffer}>> => {
    mkdirSync(CACHE, {recursive: true})
    const samples: Array<{uuid: UUID.Bytes, wav: ArrayBuffer}> = []
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioFileBox") {continue}
        const uuid = box.address.uuid
        const id = UUID.toString(uuid)
        const path = `${CACHE}/${id}.wav`
        if (!existsSync(path)) {
            const response = await fetch(`https://assets.opendaw.studio/samples/${id}`)
            if (response.ok) {
                writeFileSync(path, new Uint8Array(await response.arrayBuffer()))
            } else {
                // A user-local sample (OPFS) is unreachable here: substitute a deterministic decaying noise
                // burst — BOTH engines get the identical PCM, so the parity comparison stays valid.
                console.log(`sample ${id} not in the cloud library — substituting a synthetic burst`)
                const frames = 24000
                const data = new Float32Array(new SharedArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT))
                let seed = 0x12345678
                for (let i = 0; i < frames; i++) {
                    seed = (seed * 1664525 + 1013904223) >>> 0
                    data[i] = ((seed / 0xFFFFFFFF) * 2 - 1) * Math.exp(-6 * i / frames) * 0.5
                }
                writeFileSync(path, new Uint8Array(WavFile.encodeFloats({frames: [data], numberOfFrames: frames, numberOfChannels: 1, sampleRate: 48000})))
            }
        }
        const bytes = readFileSync(path)
        samples.push({uuid, wav: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer})
    }
    return samples
}

const renderWasm = async (boxGraph: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>, quanta: number): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const reserve = engine.input_reserve(16)
        const handle = engine.sample_take_request(reserve)
        if (handle < 0) {break}
        const id = UUID.toString(new Uint8Array(memory.buffer.slice(reserve, reserve + 16)) as UUID.Bytes)
        const found = samples.find(sample => UUID.toString(sample.uuid) === id)
        expect(found, `wasm requested sample ${id}`).toBeDefined()
        const audio = WavFile.decodeFloats(found!.wav)
        const ptr = engine.sample_allocate(handle, audio.numberOfFrames * audio.numberOfChannels * 4)
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            new Float32Array(memory.buffer, ptr + channel * audio.numberOfFrames * 4, audio.numberOfFrames).set(audio.frames[channel])
        }
        engine.sample_set_ready(handle, audio.numberOfFrames, audio.numberOfChannels, audio.sampleRate)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const output = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        output.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
    }
    return output
}

const rms = (buffer: Float32Array, from = 0, to = buffer.length): number => {
    let sum = 0
    for (let i = from; i < to; i++) {sum += buffer[i] * buffer[i]}
    return Math.sqrt(sum / Math.max(1, to - from))
}

const db = (wasm: number, ts: number): string => ts > 1e-7 && wasm > 1e-7 ? `${(20 * Math.log10(wasm / ts)).toFixed(2)} dB` : `ts=${ts.toExponential(2)} wasm=${wasm.toExponential(2)}`

describe.skipIf(!existsSync(FILE))("atstil TS vs wasm", () => {
    it("full mix + windows + per-unit", async () => {
        const graphTs = decode()
        registerScripts(graphTs)
        const samples = await fetchSamples(graphTs)
        const ts = await renderTs(ProjectSkeleton.encode(graphTs), buildSampleMap(samples), QUANTA)
        const graphWasm = decode()
        registerScripts(graphWasm)
        const wasm = await renderWasm(graphWasm, samples, QUANTA)
        const lines: string[] = [`FULL MIX 30s: ${db(rms(wasm), rms(ts.buffer))} (ts rms ${rms(ts.buffer).toExponential(3)} peak ${ts.peak.toFixed(3)}, wasm rms ${rms(wasm).toExponential(3)})`]
        const perSecond = 375 * 256 // quanta per second * interleaved-planar frame pair
        for (let second = 0; second < 30; second++) {
            const from = second * perSecond, to = from + perSecond
            lines.push(`  ${String(second).padStart(2)}s: ${db(rms(wasm, from, to), rms(ts.buffer, from, to))}`)
        }
        // Per soloed instrument unit (mute the other): localize which unit diverges.
        const units = ["69c7890a", "7c5abdd4"]
        for (const keep of units) {
            const mute = (boxGraph: BoxGraph) => {
                boxGraph.beginTransaction()
                for (const box of boxGraph.boxes()) {
                    if (box.name !== "AudioUnitBox") {continue}
                    const unit = box as unknown as {type: {getValue(): string}, mute: {setValue(value: boolean): void}}
                    if (unit.type.getValue() === "instrument" && !UUID.toString(box.address.uuid).startsWith(keep)) {unit.mute.setValue(true)}
                }
                boxGraph.endTransaction()
            }
            const graphT = decode(); registerScripts(graphT); mute(graphT)
            const soloTs = await renderTs(ProjectSkeleton.encode(graphT), buildSampleMap(samples), QUANTA)
            const graphW = decode(); registerScripts(graphW); mute(graphW)
            const soloWasm = await renderWasm(graphW, samples, QUANTA)
            lines.push(`UNIT ${keep}: ${db(rms(soloWasm), rms(soloTs.buffer))} (ts ${rms(soloTs.buffer).toExponential(3)}, wasm ${rms(soloWasm).toExponential(3)})`)
        }
        writeFileSync("/tmp/atstil-cmp.txt", lines.join("\n") + "\n")
        console.log(lines.join("\n"))
        expect(Number.isFinite(rms(ts.buffer))).toBe(true)
    }, 600000)
})
