// Shared plumbing for the atstil.od TS-vs-wasm investigation: decode the project, fetch its stock samples
// (cached in /tmp/atstil-samples, synthetic burst for user-local ones), register its Werkstatt scripts, and
// render it through the wasm engine with real PCM.
import * as path from "node:path"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {loadFullEngine} from "./load-full-engine"
import {connectSyncToEngine} from "./connect-sync"

const FILE = path.resolve(__dirname, "../../../../../test-files/atstil.od")
const CACHE = "/tmp/atstil-samples"

export const decodeAtstil = (): BoxGraph => {
    const buffer = readFileSync(FILE)
    return ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).boxGraph
}

export const registerAtstilScripts = (boxGraph: BoxGraph): number => {
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

export const fetchAtstilSamples = async (boxGraph: BoxGraph): Promise<Array<{uuid: UUID.Bytes, wav: ArrayBuffer}>> => {
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

export const renderAtstilWasm = async (boxGraph: BoxGraph, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>, quanta: number): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const reserve = engine.input_reserve(16)
        const handle = engine.sample_take_request(reserve)
        if (handle < 0) {break}
        const id = UUID.toString(new Uint8Array(memory.buffer.slice(reserve, reserve + 16)) as UUID.Bytes)
        const found = samples.find(sample => UUID.toString(sample.uuid) === id)
        if (found === undefined) {throw new Error(`wasm requested unknown sample ${id}`)}
        const audio = WavFile.decodeFloats(found.wav)
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

export const rmsOf = (buffer: Float32Array, from = 0, to = buffer.length): number => {
    let sum = 0
    for (let i = from; i < to; i++) {sum += buffer[i] * buffer[i]}
    return Math.sqrt(sum / Math.max(1, to - from))
}
