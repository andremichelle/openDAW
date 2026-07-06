// DIAGNOSTIC (PeakMeter crash after freeze in 80s.od): render the freeze stem of EACH instrument unit over
// the FULL project duration with REAL samples, hunting a non-finite transient (an f32 overflow in a device
// would land ±Infinity in the freeze WAV, and the live strip meter latches a single Infinity forever).
import * as path from "node:path"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {ApparatDeviceBox, AudioUnitBox, SpielwerkDeviceBox, TimelineBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const QUANTUM = 128
const FREEZE_FLAGS = 1 | 8
const CACHE = "/tmp/opendaw-test-samples"

const decode = (): BoxGraph => {
    const buffer = readFileSync(path.resolve(__dirname, "../../../../test-files/80s.od"))
    return ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).boxGraph
}

const registerScripts = (boxGraph: BoxGraph): void => {
    for (const box of boxGraph.boxes()) {
        const config = box instanceof ApparatDeviceBox ? {header: "apparat", registry: "apparatProcessors", fn: "apparat"}
            : box instanceof WerkstattDeviceBox ? {header: "werkstatt", registry: "werkstattProcessors", fn: "werkstatt"}
            : box instanceof SpielwerkDeviceBox ? {header: "spielwerk", registry: "spielwerkProcessors", fn: "spielwerk"} : undefined
        if (config === undefined) {continue}
        const code = (box as unknown as {code: {getValue(): string}}).code.getValue()
        const match = code.match(/^\/\/ @\w+ js \d+ (\d+)\n/)
        if (match === null) {continue}
        new Function(ScriptCompiler.wrap(
            {headerTag: config.header, registryName: config.registry, functionName: config.fn},
            UUID.toString(box.address.uuid), parseInt(match[1]), code.slice(match[0].length)))()
    }
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
                console.log(`sample ${id} not in the cloud library — substituting a synthetic burst`)
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

const feedSamples = (engine: any, memory: WebAssembly.Memory, samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>): void => {
    for (; ;) {
        const reserve = engine.input_reserve(16)
        const handle = engine.sample_take_request(reserve)
        if (handle < 0) {break}
        const id = UUID.toString(new Uint8Array(memory.buffer.slice(reserve, reserve + 16)) as UUID.Bytes)
        const found = samples.find(sample => UUID.toString(sample.uuid) === id)
        if (found === undefined) {throw new Error(`engine requested unknown sample ${id}`)}
        const audio = WavFile.decodeFloats(found.wav)
        const pointer = engine.sample_allocate(handle, audio.numberOfFrames * audio.numberOfChannels * 4)
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            new Float32Array(memory.buffer, pointer + channel * audio.numberOfFrames * 4, audio.numberOfFrames).set(audio.frames[channel])
        }
        engine.sample_set_ready(handle, audio.numberOfFrames, audio.numberOfChannels, audio.sampleRate)
    }
}

describe("80s.od full-length freeze render", () => {
    it("every instrument unit's freeze stem is finite over the whole song", async () => {
        const boxGraph = decode()
        registerScripts(boxGraph)
        const samples = await fetchSamples(boxGraph)
        const timeline = boxGraph.boxes().find(box => box instanceof TimelineBox) as TimelineBox
        const duration = (timeline as unknown as {durationInPulses: {getValue(): number}}).durationInPulses.getValue()
        const bpm = (timeline as unknown as {bpm: {getValue(): number}}).bpm.getValue()
        const seconds = (duration / 960) * (60 / bpm)
        const quanta = Math.ceil(seconds * 48_000 / QUANTUM) + 64
        console.log(`duration ${duration} pulses @ ${bpm} bpm = ${seconds.toFixed(1)} s -> ${quanta} quanta`)
        const units = boxGraph.boxes()
            .filter((box): box is AudioUnitBox => box instanceof AudioUnitBox)
            .filter(box => (box as unknown as {type: {getValue(): string}}).type.getValue() === "instrument")
            .sort((a, b) => a.index.getValue() - b.index.getValue())
        for (const unit of units) {
            const {engine, memory} = await loadFullEngine()
            const sync = connectSyncToEngine(engine, memory, boxGraph)
            await sync.settle()
            const pointer = engine.input_reserve(20)
            new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
            new DataView(memory.buffer, pointer, 20).setUint32(16, FREEZE_FLAGS, true)
            engine.set_stem_export(1)
            engine.bind()
            await sync.settle()
            feedSamples(engine, memory, samples)
            await sync.settle()
            engine.set_metronome_enabled(0)
            engine.stop(); engine.play()
            let peak = 0
            let firstBad = -1
            for (let quantum = 0; quantum < quanta && firstBad < 0; quantum++) {
                engine.render()
                const staging = new Float32Array(memory.buffer, engine.stem_output_ptr(), 2 * QUANTUM)
                for (let index = 0; index < staging.length; index++) {
                    const value = staging[index]
                    if (!Number.isFinite(value)) {
                        firstBad = quantum
                        console.log(`unit ${unit.index.getValue()}: NON-FINITE ${value} @ quantum ${quantum} (${(quantum * QUANTUM / 48_000).toFixed(2)} s) index ${index}`)
                        break
                    }
                    peak = Math.max(peak, Math.abs(value))
                }
            }
            console.log(`unit index ${unit.index.getValue()}: peak ${peak.toFixed(3)}${firstBad >= 0 ? ` FIRST BAD @ ${firstBad}` : " all finite"}`)
            expect(firstBad, `unit ${unit.index.getValue()} freeze stem finite`).toBe(-1)
        }
    }, 600_000)
})
