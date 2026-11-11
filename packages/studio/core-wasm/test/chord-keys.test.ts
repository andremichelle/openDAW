// Chord Keys in the full engine. The instrument is an Apparat script that outputs DC pitch / 1000 per held voice,
// so the rendered level is the sum of the sounding pitches (0 = nothing sounds).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBox, AudioUnitBox, ChordKeysDeviceBox, KeyEventBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

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

type Note = { pitch: number, position?: number, duration?: number }
type Settings = { root?: number, scale?: number, follow?: boolean, keys?: ReadonlyArray<Harmony.Key & { position: number }> }

const HELD = 200_000
const sum = (pitches: ReadonlyArray<number>) => pitches.reduce((total, pitch) => total + pitch, 0) / 1000

const createScene = async (notes: ReadonlyArray<Note>, settings: Settings) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
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
    ChordKeysDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.root.setValue(settings.root ?? 0)
        box.scale.setValue(settings.scale ?? 0)
        box.follow.setValue(settings.follow ?? false)
    })
    ;(settings.keys ?? []).forEach(({position, root, bits}) => KeyEventBox.create(source, UUID.generate(), box => {
        box.track.refer(timelineBox.keyTrack.events)
        box.position.setValue(position)
        box.root.setValue(root)
        box.scale.setValue(bits)
    }))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    notes.forEach(({pitch, position, duration}) => NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(position ?? 0)
        box.duration.setValue(duration ?? HELD)
        box.pitch.setValue(pitch)
        box.velocity.setValue(0.8)
        box.cent.setValue(0)
    }))
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(HELD)
        box.loopDuration.setValue(HELD)
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
    const level = (quanta: number): number => {
        let last = 0
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            last = new Float32Array(memory.buffer, engine.output_ptr(), half)[half - 1]
        }
        return last
    }
    engine.stop()
    engine.play()
    return {level, close: () => sync.close()}
}

const scaleIndex = (name: string) => MidiKeys.StockScales.findIndex(scale => scale.name === name)

describe("Chord Keys", () => {
    it("plays the triad of each white key in C major", async () => {
        const scene = await createScene([{pitch: 62}], {})
        expect(scene.level(50)).toBeCloseTo(sum([62, 65, 69]), 6)
        scene.close()
    }, 60000)
    it("adds and removes the 7th while the chord sounds", async () => {
        const scene = await createScene([{pitch: 60}, {pitch: 61, position: 1920, duration: 1920}], {})
        expect(scene.level(50)).toBeCloseTo(sum([60, 64, 67]), 6)
        expect(scene.level(500)).toBeCloseTo(sum([60, 64, 67, 71]), 6)
        expect(scene.level(1000)).toBeCloseTo(sum([60, 64, 67]), 6)
        scene.close()
    }, 60000)
    it("uses its own root and scale, chords rise from the root", async () => {
        const scene = await createScene([{pitch: 64}], {root: 9, scale: scaleIndex("Natural Minor")})
        expect(scene.level(50)).toBeCloseTo(sum([72, 76, 79]), 6)
        scene.close()
    }, 60000)
    it("follows the project key", async () => {
        const keys = [{position: 0, root: 2, bits: Harmony.MajorBits}]
        const scene = await createScene([{pitch: 60}], {follow: true, keys})
        expect(scene.level(50)).toBeCloseTo(sum([62, 66, 69]), 6)
        scene.close()
    }, 60000)
})
