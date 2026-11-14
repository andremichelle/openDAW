// Euclid in the FULL engine: the lanes reach the device as a table, it plays their hits and passes notes through.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox, AudioUnitBox, EuclidDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox
} from "@opendaw/studio-boxes"
import {Euclid, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

// the output level is the sum of the sounding pitches over 1000
const INSTRUMENT = `class Processor {
    voices = new Map()
    noteOn(pitch, velocity, cent, id) { this.voices.set(id, pitch) }
    noteOff(id) { this.voices.delete(id) }
    process(output, block) {
        const [l, r] = output
        let level = 0
        for (const pitch of this.voices.values()) { level += pitch / 1000 }
        for (let i = block.s0; i < block.s1; i++) { l[i] += level; r[i] += level }
    }
}`

type Lane = { note: number, pulses: number }
// 120 bpm at 48 kHz: a quantum of 128 frames is 5.12 pulses, a sixteenth 46.875 quanta
const QUANTA_PER_SIXTEENTH = 240 / 5.12

const createScene = async (lanes: ReadonlyArray<Lane>, held: number = 0, pattern: number = 0) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + INSTRUMENT)
    })
    const device = EuclidDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.pattern.setValue(pattern)
    })
    lanes.forEach(({note, pulses}) => Euclid.rhythmOf(Euclid.createLane(source, device, note), pattern).pulses.setValue(pulses))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    if (held > 0) {
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(0)
            box.duration.setValue(200_000)
            box.pitch.setValue(held)
            box.velocity.setValue(0.8)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(200_000)
        box.loopDuration.setValue(200_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, INSTRUMENT))()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop()
    engine.play()
    // the level at the end of every quantum
    const levels = (quanta: number): ReadonlyArray<number> => Array.from({length: quanta}, () => {
        engine.render()
        return Math.round(new Float32Array(memory.buffer, engine.output_ptr(), half)[half - 1] * 1000)
    })
    return {levels, source, device, sync, close: () => sync.close()}
}

const at = (sixteenth: number, inside: number = 0.5): number => Math.floor((sixteenth + inside) * QUANTA_PER_SIXTEENTH)

describe("Euclid", () => {
    it("plays a lane's hits for one step each", async () => {
        const scene = await createScene([{note: 60, pulses: 4}])
        const levels = scene.levels(at(16, 0))
        expect([0, 4, 8, 12].map(step => levels[at(step)])).toEqual([60, 60, 60, 60])
        expect([1, 2, 5, 13].map(step => levels[at(step)])).toEqual([0, 0, 0, 0])
        scene.close()
    }, 60000)
    it("plays two lanes and passes a held note through", async () => {
        const scene = await createScene([{note: 36, pulses: 4}, {note: 42, pulses: 8}], 72)
        const levels = scene.levels(at(8, 0))
        expect(levels[at(0)]).toBe(36 + 42 + 72)
        expect(levels[at(1)]).toBe(72)
        expect(levels[at(2)]).toBe(42 + 72)
        expect(levels[at(4)]).toBe(36 + 42 + 72)
        scene.close()
    }, 60000)
    it("starts with the stored pattern", async () => {
        const scene = await createScene([{note: 60, pulses: 4}], 0, 1)
        const levels = scene.levels(at(16, 0))
        expect([0, 4, 8, 12].map(step => levels[at(step)])).toEqual([60, 60, 60, 60])
        scene.close()
    }, 60000)
    it("switches to another pattern on the next bar", async () => {
        const scene = await createScene([{note: 60, pulses: 4}])
        const {source, device, sync} = scene
        source.beginTransaction()
        Euclid.lanesOf(device).forEach(lane => Euclid.rhythmOf(lane, 1).pulses.setValue(16))
        source.endTransaction()
        await sync.settle()
        const first = scene.levels(at(2))
        source.beginTransaction()
        device.pattern.setValue(1)
        source.endTransaction()
        await sync.settle()
        const levels = [...first, ...scene.levels(at(24, 0) - first.length)]
        expect([5, 6, 7].map(step => levels[at(step)])).toEqual([0, 0, 0])
        expect([17, 18, 19].map(step => levels[at(step)])).toEqual([60, 60, 60])
        scene.close()
    }, 60000)
})
