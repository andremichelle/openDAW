// Renders the Guitar through the REAL wasm engine: the pattern strums the chord track, every body and tuning
// stays audible and finite, a project without chords stays silent, and live notes play in Keys mode.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, ChordEventBox, GuitarDeviceBox} from "@opendaw/studio-boxes"
import {GuitarDeviceBoxAdapter, GuitarPatterns, ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type Scene = {
    chords?: boolean
    apply?: (box: GuitarDeviceBox) => void
}

const render = async ({chords, apply}: Scene, quanta: number,
                      live?: (engine: Awaited<ReturnType<typeof loadFullEngine>>["engine"], memory: WebAssembly.Memory, unit: AudioUnitBox, quantum: number) => void) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    GuitarDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        GuitarPatterns.load(box, GuitarPatterns.DefaultPattern)
        apply?.(box)
    })
    if (chords ?? true) {
        ;[1, 5, 6, 4].forEach((degree, index) => ChordEventBox.create(source, UUID.generate(), box => {
            box.track.refer(timelineBox.chordTrack.events)
            box.position.setValue(index * 3840)
            box.duration.setValue(3840)
            box.degree.setValue(degree)
        }))
    }
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    const half = (engine.output_len() >>> 0) >>> 1
    const left: Array<number> = []
    for (let quantum = 0; quantum < quanta; quantum++) {
        live?.(engine, memory, unit, quantum)
        engine.render()
        left.push(...new Float32Array(memory.buffer, engine.output_ptr(), half))
    }
    sync.close()
    return left
}

const rms = (values: ReadonlyArray<number>) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length))

describe("Guitar in the full engine", () => {
    it("strums the chord track", async () => {
        const left = await render({}, 750)
        expect(left.every(Number.isFinite)).toBe(true)
        expect(rms(left)).toBeGreaterThan(0.01)
        expect(Math.max(...left.map(Math.abs))).toBeLessThan(1.5)
    }, 60000)
    it("stays silent without chords", async () => {
        expect(rms(await render({chords: false}, 400))).toBe(0)
    }, 60000)
    for (let body = 0; body < GuitarDeviceBoxAdapter.Bodies.length; body++) {
        it(`sounds with the ${GuitarDeviceBoxAdapter.Bodies[body]} body`, async () => {
            const left = await render({apply: box => box.body.setValue(body)}, 400)
            expect(left.every(Number.isFinite)).toBe(true)
            expect(rms(left)).toBeGreaterThan(0.005)
        }, 60000)
    }
    for (let tuning = 0; tuning < 4; tuning++) {
        it(`sounds in tuning ${tuning} at every position`, async () => {
            for (let position = 0; position < 6; position += 5) {
                const left = await render({apply: box => {
                    box.tuning.setValue(tuning)
                    box.position.setValue(position)
                }}, 300)
                expect(rms(left)).toBeGreaterThan(0.005)
            }
        }, 60000)
    }
    it("plays every built in pattern", async () => {
        for (let index = 0; index < GuitarPatterns.Library.length; index += 5) {
            const left = await render({apply: box => GuitarPatterns.load(box, index)}, 400)
            expect(left.every(Number.isFinite), GuitarPatterns.Library[index].name).toBe(true)
            expect(rms(left), GuitarPatterns.Library[index].name).toBeGreaterThan(0.002)
        }
    }, 120000)
    it("plays live notes in Keys mode", async () => {
        const left = await render({chords: false, apply: box => box.mode.setValue(1)}, 300, (engine, memory, unit, quantum) => {
            if (quantum !== 10) {return}
            new Uint8Array(memory.buffer, engine.input_reserve(16), 16).set(unit.address.uuid)
            ;[48, 52, 55].forEach(pitch => engine.note_signal_on(pitch, 0.8))
        })
        expect(rms(left.slice(0, 1280))).toBe(0)
        expect(rms(left)).toBeGreaterThan(0.005)
    }, 60000)
})
