// Scale Matrix in the full engine. The instrument is an Apparat script that outputs DC pitch / 1000 per held voice,
// so the rendered level tells which keys reached it (0 = nothing sounds).
import {describe, expect, it} from "vitest"
import {isDefined, UUID} from "@opendaw/lib-std"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBox, AudioUnitBox, KeyEventBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, ScaleMatrixDeviceBox, TrackBox
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
type KeyEvent = { position: number, root: number, bits: number }
type Settings = { root?: number, scale?: number, follow?: boolean, keys?: ReadonlyArray<KeyEvent>, storage?: Harmony.Key }

const HELD = 200_000

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
    const matrix = ScaleMatrixDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.root.setValue(settings.root ?? 0)
        box.scale.setValue(settings.scale ?? 0)
        box.follow.setValue(settings.follow ?? false)
    })
    if (isDefined(settings.storage)) {
        timelineBox.keyTrack.root.setValue(settings.storage.root)
        timelineBox.keyTrack.scale.setValue(settings.storage.bits)
    }
    const keyEvents = (settings.keys ?? []).map(({position, root, bits}) => KeyEventBox.create(source, UUID.generate(), box => {
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
    const edit = async (modify: () => void): Promise<void> => {
        source.beginTransaction(); modify(); source.endTransaction()
        await sync.settle()
    }
    engine.stop(); engine.play()
    return {matrix, keyEvents, timelineBox, level, edit, close: () => sync.close()}
}

const levelOf = async (pitch: number, settings: Settings): Promise<number> => {
    const scene = await createScene([{pitch}], settings)
    const level = scene.level(50)
    scene.close()
    return level
}

const scaleIndex = (name: string) => MidiKeys.StockScales.findIndex(scale => scale.name === name)

describe("Scale Matrix", () => {
    it("keeps keys of the scale and moves the others down on ties", async () => {
        expect(await levelOf(60, {})).toBeCloseTo(0.060, 6)
        expect(await levelOf(61, {})).toBeCloseTo(0.060, 6)
        expect(await levelOf(66, {})).toBeCloseTo(0.065, 6)
    }, 60000)
    it("matches the TS quantiser for every stock scale", async () => {
        for (let scale = 0; scale < MidiKeys.StockScales.length; scale++) {
            const root = scale % 12
            const pitch = 61 + (scale % 5)
            const expected = Harmony.quantise(pitch, {root, bits: MidiKeys.StockScales[scale].bits})
            expect(await levelOf(pitch, {root, scale})).toBeCloseTo(expected / 1000, 6)
        }
    }, 120000)
    it("follows the project key, C major without key events", async () => {
        expect(await levelOf(61, {follow: true})).toBeCloseTo(0.060, 6)
        const harmonicMinor = MidiKeys.StockScales[scaleIndex("Harmonic Minor")].bits
        const keys = [{position: 0, root: 9, bits: harmonicMinor}]
        expect(await levelOf(70, {follow: true, root: 0, scale: 0, keys}))
            .toBeCloseTo(Harmony.quantise(70, {root: 9, bits: harmonicMinor}) / 1000, 6)
    }, 60000)
    it("follows the stored key of the key track before the first key event", async () => {
        const storage: Harmony.Key = {root: 2, bits: Harmony.MajorBits}
        expect(await levelOf(60, {follow: true, storage})).toBeCloseTo(0.059, 6)
        expect(await levelOf(60, {follow: true, storage, keys: [{position: 0, root: 0, bits: Harmony.MajorBits}]}))
            .toBeCloseTo(0.060, 6)
    }, 60000)
    it("reads the key at each note's position", async () => {
        const keys = [{position: 1920, root: 1, bits: Harmony.MajorBits}]
        const scene = await createScene([{pitch: 61, position: 0}, {pitch: 62, position: 1920}], {follow: true, keys})
        expect(scene.level(20)).toBeCloseTo(0.060, 6)
        expect(scene.level(400)).toBeCloseTo(0.060 + 0.061, 6)
        scene.close()
    }, 60000)
    it("picks up key edits for the next note", async () => {
        const scene = await createScene([{pitch: 62, position: 0, duration: 480}, {pitch: 62, position: 1920}],
            {follow: true, keys: [{position: 0, root: 0, bits: Harmony.MajorBits}]})
        expect(scene.level(20)).toBeCloseTo(0.062, 6)
        await scene.edit(() => scene.keyEvents[0].root.setValue(1))
        expect(scene.level(400)).toBeCloseTo(0.061, 6)
        scene.close()
    }, 60000)
    it("shares a key two notes land on and ends it with the last release", async () => {
        const scene = await createScene([{pitch: 60, duration: 960}, {pitch: 61, duration: 1920}], {})
        expect(scene.level(20)).toBeCloseTo(0.060, 6)
        expect(scene.level(250)).toBeCloseTo(0.060, 6)
        expect(scene.level(400)).toBe(0)
        scene.close()
    }, 60000)
    it("ends a held note on its release after the settings changed", async () => {
        const scene = await createScene([{pitch: 61, duration: 1920}], {})
        expect(scene.level(20)).toBeCloseTo(0.060, 6)
        await scene.edit(() => scene.matrix.root.setValue(1))
        expect(scene.level(20)).toBeCloseTo(0.060, 6)
        expect(scene.level(800)).toBe(0)
        scene.close()
    }, 60000)
    it("disabling ends the notes it passed", async () => {
        const scene = await createScene([{pitch: 60}, {pitch: 61}], {})
        expect(scene.level(50)).toBeCloseTo(0.060, 6)
        await scene.edit(() => scene.matrix.enabled.setValue(false))
        expect(scene.level(50)).toBe(0)
        scene.close()
    }, 60000)
})
