// openDrum Kick in the FULL engine: notes on its track play the Kick engine, the same hit the preview module renders.
import {readFileSync} from "fs"
import {resolve} from "path"
import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, OpenDrumKickDeviceBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLE_RATE = 48000
const SAMPLES_PER_BAR = 3840 * 25 // 48k, 120 bpm, 960 per quarter

type Note = { position: int, pitch: int }

const render = async (notes: ReadonlyArray<Note>, frames: int): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    OpenDrumKickDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    notes.forEach(({position, pitch}) => NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(position)
        box.duration.setValue(240)
        box.pitch.setValue(pitch)
        box.velocity.setValue(1.0)
    }))
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const half = (engine.output_len() >>> 0) >>> 1
    const left = new Float32Array(Math.ceil(frames / half) * half)
    for (let index = 0; index < left.length / half; index++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), index * half)
    }
    sync.close()
    return left
}

// the default Kick (the box defaults) rendered by the preview module, at full velocity
const preview = (frames: int): Float32Array => {
    const bytes = readFileSync(resolve(__dirname, "../dist/wasm/opendrum_wasm.wasm"))
    const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports
    const memory = exports.memory as WebAssembly.Memory
    const alloc = exports.alloc as (length: int) => int
    const kick = exports.kick as (input: int, length: int, output: int, capacity: int) => int
    const values = [51.43, 28.23, 0.0025, 4.1, 1.137, 0.078, 0.001, 0.034, 873.1, 0.295, 0, 0.25, 1, 0.82, 0.5, 0,
        0.25, 0, 0.5, 0]
    const input = Float32Array.from([SAMPLE_RATE, frames, frames, 0, 120, ...values])
    const inputPointer = alloc(input.byteLength)
    const outputPointer = alloc(frames * 4)
    new Float32Array(memory.buffer, inputPointer, input.length).set(input)
    const written = kick(inputPointer, input.byteLength, outputPointer, frames * 4)
    const output = new Float32Array(frames)
    output.set(new Float32Array(memory.buffer, outputPointer, written / 4))
    return output
}

const rms = (samples: Float32Array, from: int, to: int): number =>
    Math.sqrt(samples.subarray(from, to).reduce((sum, value) => sum + value * value, 0) / (to - from))

const correlation = (a: Float32Array, b: Float32Array): number => {
    let ab = 0, aa = 0, bb = 0
    for (let index = 0; index < a.length; index++) {
        ab += a[index] * b[index]
        aa += a[index] * a[index]
        bb += b[index] * b[index]
    }
    return ab / Math.sqrt(aa * bb)
}

const risingCrossings = (samples: Float32Array): int =>
    samples.reduce((count, value, index) => index > 0 && samples[index - 1] < 0 && value >= 0 ? count + 1 : count, 0)

describe("openDrum Kick device", () => {
    it("plays a note as the Kick engine renders it", async () => {
        const output = await render([{position: 0, pitch: 60}], SAMPLES_PER_BAR)
        expect(output.every(Number.isFinite)).toBe(true)
        const length = SAMPLE_RATE / 2
        expect(correlation(output.subarray(0, length), preview(length))).toBeGreaterThan(0.9999)
    })

    it("plays every note and transposes by the key against 60", async () => {
        const output = await render([{position: 0, pitch: 60}, {position: 3840, pitch: 72}], 2 * SAMPLES_PER_BAR)
        expect(rms(output, 0, SAMPLE_RATE / 4)).toBeGreaterThan(0.01)
        expect(rms(output, SAMPLES_PER_BAR, SAMPLES_PER_BAR + SAMPLE_RATE / 4)).toBeGreaterThan(0.01)
        const tail = (start: int) => output.subarray(start + SAMPLE_RATE / 4, start + SAMPLE_RATE / 2)
        const ratio = risingCrossings(tail(SAMPLES_PER_BAR)) / risingCrossings(tail(0))
        expect(ratio).toBeGreaterThan(1.9)
        expect(ratio).toBeLessThan(2.1)
    })
})
