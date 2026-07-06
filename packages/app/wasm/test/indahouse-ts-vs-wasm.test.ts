// TS-vs-wasm parity for "test-files/indahouse.od" (user: "sounds very different after the first kick").
// Root cause was the Playfield SlotVoice writing its FINAL sample before finishing: a mono retrigger on a
// voice whose natural (gate-Off) release already ran shortens `release` to the 5 ms fast tail while
// `decay_position` sits far back, the release term goes hugely negative and squares into a ~7x one-sample
// spike per kick — which the master Maximizer (0.2 s release) then clamped, pulling the whole mix ~-14 dB.
// TS drops that sample (`SampleVoice` returns BEFORE writing); the voice now mirrors it. This renders the
// project's kick+pumping-Revamp+master-chain in both engines with identical PCM and holds every per-second
// RMS window to a hard tolerance.
import * as path from "node:path"
import {describe, expect, it} from "vitest"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {buildSampleMap, renderTs} from "./helpers/render-ts"

const FILE = path.resolve(__dirname, "../../../../test-files/indahouse.od")
const CACHE = "/tmp/indahouse-samples"
const QUANTA = 6000 // 16 s at 48 kHz / 128 frames
const TOLERANCE_DB = 0.1 // the broken voice sat at ~-14 dB per window

const decode = () => {
    const buffer = readFileSync(FILE)
    return ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).boxGraph
}

const fetchSamples = async (boxGraph: BoxGraph): Promise<Array<{uuid: UUID.Bytes, wav: ArrayBuffer}>> => {
    mkdirSync(CACHE, {recursive: true})
    const samples: Array<{uuid: UUID.Bytes, wav: ArrayBuffer}> = []
    for (const box of boxGraph.boxes()) {
        if (box.name !== "AudioFileBox") {continue}
        const uuid = box.address.uuid
        const id = UUID.toString(uuid)
        const file = `${CACHE}/${id}.wav`
        if (!existsSync(file)) {
            const response = await fetch(`https://assets.opendaw.studio/samples/${id}`)
            if (response.ok) {
                writeFileSync(file, new Uint8Array(await response.arrayBuffer()))
            } else {
                // A user-local sample is unreachable here: substitute a deterministic decaying noise burst —
                // BOTH engines get the identical PCM, so the parity comparison stays valid.
                const frames = 24000
                const data = new Float32Array(new SharedArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT))
                let seed = 0x12345678
                for (let index = 0; index < frames; index++) {
                    seed = (seed * 1664525 + 1013904223) >>> 0
                    data[index] = ((seed / 0xFFFFFFFF) * 2 - 1) * Math.exp(-6 * index / frames) * 0.5
                }
                writeFileSync(file, new Uint8Array(WavFile.encodeFloats({frames: [data], numberOfFrames: frames, numberOfChannels: 1, sampleRate: 48000})))
            }
        }
        const bytes = readFileSync(file)
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
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        output.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
    }
    return output
}

const rms = (buffer: Float32Array, from = 0, to = buffer.length): number => {
    let sum = 0
    for (let index = from; index < to; index++) {sum += buffer[index] * buffer[index]}
    return Math.sqrt(sum / Math.max(1, to - from))
}

describe.skipIf(!existsSync(FILE))("indahouse TS vs wasm", () => {
    it("matches every per-second RMS window", async () => {
        const graphTs = decode()
        const samples = await fetchSamples(graphTs)
        const ts = await renderTs(ProjectSkeleton.encode(graphTs), buildSampleMap(samples), QUANTA)
        const wasm = await renderWasm(decode(), samples, QUANTA)
        const perSecond = 375 * 256
        for (let second = 0; second < 16; second++) {
            const from = second * perSecond, to = from + perSecond
            const tsRms = rms(ts.buffer, from, to)
            const wasmRms = rms(wasm, from, to)
            expect(tsRms).toBeGreaterThan(1e-6)
            const delta = 20 * Math.log10(wasmRms / tsRms)
            expect(Math.abs(delta), `second ${second}: wasm ${wasmRms.toExponential(3)} vs ts ${tsRms.toExponential(3)} (${delta.toFixed(2)} dB)`)
                .toBeLessThan(TOLERANCE_DB)
        }
    }, 600000)
})
