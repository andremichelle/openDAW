// openDrum devices in the FULL engine: a note on the track plays the device's engine, the hit the preview module renders.
import {readFileSync} from "fs"
import {resolve} from "path"
import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {
    AudioUnitBox, BoxIO, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox,
    OpenDrumBellDeviceBox, OpenDrumClapDeviceBox, OpenDrumCymbalDeviceBox, OpenDrumHatDeviceBox, OpenDrumKickDeviceBox,
    OpenDrumPercDeviceBox, OpenDrumRimDeviceBox, OpenDrumShakerDeviceBox, OpenDrumSnareDeviceBox, OpenDrumTomDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLE_RATE = 48000
const SAMPLES_PER_BAR = 3840 * 25 // 48k, 120 bpm, 960 per quarter

type Note = { position: int, pitch: int }

// every device's box defaults in box key order, as the display module reads them
type Install = (source: BoxGraph<BoxIO.TypeMap>, unit: AudioUnitBox) => unknown
const Devices: Record<string, { install: Install, values: ReadonlyArray<number> }> = {
    kick: {install: (source, unit) => OpenDrumKickDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [51.43, 28.23, 0.0025, 4.1, 1.137, 0.078, 0.001, 0.295, 0.034, 873.1, 0.5, 0.82, 0, 2, 1,
            0.25, 0, 1, 0, 0]},
    snare: {install: (source, unit) => OpenDrumSnareDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [171.16, 1.943, 0.7243, 2.065, 0.0092, 0.2093, -0.0221, 0, -5.3, 0.1944, 0.46, -0.2745, 0.1079, 4779,
            0.1612, 0, 0, 1, 0, 0]},
    clap: {install: (source, unit) => OpenDrumClapDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [4, 0.0115, 0.71, 0, 0.00075, 0.019, 0.6, 0, 1055, 1, -1.25, 0.41, 0.5, 0, 1, 0, 0]},
    tom: {install: (source, unit) => OpenDrumTomDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [88, 0.4, 0.05, 0, 0.62, 0, 0, 0, 0.67, 0, 0.2, 0, -34, 0.7, 0, 0, 0, 1, 0, 0]},
    rim: {install: (source, unit) => OpenDrumRimDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [476, 3.6, 1, 0, 6.3, 0.17, 0.035, 0.012, 0.7, 12, 0, 0.05, 3, 300, 1, -3, 1, 0, 0]},
    hat: {install: (source, unit) => OpenDrumHatDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [1, 6300, 0, 0.13, 0, 0, 0, 0, 0, 1, 0, 0]},
    shaker: {install: (source, unit) => OpenDrumShakerDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [7200, 0.02, 0.012, 0.3, 0, 1, 0, 0]},
    cymbal: {install: (source, unit) => OpenDrumCymbalDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [1, 0, 0, 0.75, 0, 1, 0, 0]},
    bell: {install: (source, unit) => OpenDrumBellDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [558, 1.477, 0.7, 1050, 0.8, 0.7, 0, 1, 0, 0]},
    perc: {install: (source, unit) => OpenDrumPercDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input)),
        values: [120, 1, 0.2, 0.03, 48, 0.02, 0.2, 0, 0, 0, 0, 1, 0, 0]}
}

const render = async (install: Install, notes: ReadonlyArray<Note>, frames: int, channel: 0 | 1 = 0): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    install(source, unit)
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
        left.set(new Float32Array(memory.buffer, engine.output_ptr() + channel * half * 4, half), index * half)
    }
    sync.close()
    return left
}

// the device's box defaults rendered by the preview module, at full velocity
const preview = (name: string, values: ReadonlyArray<number>, frames: int): Float32Array => {
    const bytes = readFileSync(resolve(__dirname, "../dist/wasm/opendrum_wasm.wasm"))
    const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports
    const memory = exports.memory as WebAssembly.Memory
    const alloc = exports.alloc as (length: int) => int
    const render = exports[name] as (input: int, length: int, output: int, capacity: int) => int
    const input = Float32Array.from([SAMPLE_RATE, frames, frames, 0, 120, ...values])
    const inputPointer = alloc(input.byteLength)
    const outputPointer = alloc(frames * 4)
    new Float32Array(memory.buffer, inputPointer, input.length).set(input)
    const written = render(inputPointer, input.byteLength, outputPointer, frames * 4)
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

describe("openDrum devices", () => {
    Object.entries(Devices).forEach(([name, {install, values}]) =>
        it(`${name} plays a note as its engine renders it`, async () => {
            const output = await render(install, [{position: 0, pitch: 60}], SAMPLES_PER_BAR)
            expect(output.every(Number.isFinite)).toBe(true)
            const length = SAMPLE_RATE / 2
            expect(rms(output, 0, length)).toBeGreaterThan(0.001)
            expect(correlation(output.subarray(0, length), preview(name, values, length))).toBeGreaterThan(0.9999)
        }))

    it("pans the hit, centred both sides are the same", async () => {
        const install = (panning: number): Install => (source, unit) =>
            OpenDrumSnareDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.input)
                box.panning.setValue(panning)
            })
        const length = SAMPLE_RATE / 2
        const notes = [{position: 0, pitch: 60}]
        const centreLeft = await render(install(0), notes, length, 0)
        const centreRight = await render(install(0), notes, length, 1)
        expect(centreRight).toEqual(centreLeft)
        const leftOnly = await render(install(-1), notes, length, 1)
        expect(rms(leftOnly, 0, length)).toBe(0)
        const halfRight = await render(install(0.5), notes, length, 0)
        expect(rms(halfRight, 0, length) / rms(centreLeft, 0, length)).toBeCloseTo(0.5, 3)
    })

    it("kick plays every note and transposes by the key against 60", async () => {
        const notes = [{position: 0, pitch: 60}, {position: 3840, pitch: 72}]
        const output = await render(Devices.kick.install, notes, 2 * SAMPLES_PER_BAR)
        expect(rms(output, 0, SAMPLE_RATE / 4)).toBeGreaterThan(0.01)
        expect(rms(output, SAMPLES_PER_BAR, SAMPLES_PER_BAR + SAMPLE_RATE / 4)).toBeGreaterThan(0.01)
        const tail = (start: int) => output.subarray(start + SAMPLE_RATE / 4, start + SAMPLE_RATE / 2)
        const ratio = risingCrossings(tail(SAMPLES_PER_BAR)) / risingCrossings(tail(0))
        expect(ratio).toBeGreaterThan(1.9)
        expect(ratio).toBeLessThan(2.1)
    })
})
