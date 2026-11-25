// The user's STOP (`stop_faded`) fades the mix out over the next quantum, then resets every plugin: a reset cuts
// the tails still ringing, which clicks. A Vaporisateur holds a note, the stop arrives while it sounds.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const build = () => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    InstrumentFactories.Vaporisateur.create(source, unit.input, "Vaporisateur", InstrumentFactories.Vaporisateur.defaultIcon)
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.pitch.setValue(60)
        box.velocity.setValue(0.8)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.loopDuration.setValue(10_000)
    })
    source.endTransaction()
    return source
}

describe("a faded stop", () => {
    it("fades the mix out over the next quantum, then everything is silent", async () => {
        const source = build()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const half = (engine.output_len() >>> 0) / 2
        const quantum = (): Array<number> => {
            engine.render()
            return Array.from(new Float32Array(memory.buffer, engine.output_ptr(), half))
        }
        const peak = (samples: ReadonlyArray<number>): number => Math.max(...samples.map(Math.abs))
        engine.stop(); engine.play()
        const playing = Array.from({length: 40}, quantum).flat()
        expect(peak(playing.slice(-half))).toBeGreaterThan(0.01)
        engine.stop_faded()
        const faded = quantum()
        expect(peak(faded.slice(0, 16))).toBeGreaterThan(0.001)
        expect(faded[half - 1]).toBe(0)
        expect(faded.every((sample, index) => Math.abs(sample) <= 1.0 - (index + 1) / half + 1e-6)).toBe(true)
        expect(peak(Array.from({length: 20}, quantum).flat())).toBe(0)
    }, 30000)
})
