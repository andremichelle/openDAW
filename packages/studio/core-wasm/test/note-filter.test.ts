// Note Filter in the full engine. The instrument is an Apparat script that outputs DC pitch / 1000 per held voice,
// so the rendered level tells which key reached it (0 = nothing sounds).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteFilterDeviceBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
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

type Settings = {min?: number, max?: number, set?: boolean, transpose?: number, key?: number}

const createScene = async (pitch: number, duration: number, settings: Settings) => {
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
    const filter = NoteFilterDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.min.setValue(settings.min ?? 0)
        box.max.setValue(settings.max ?? 127)
        box.set.setValue(settings.set ?? false)
        box.transpose.setValue(settings.transpose ?? 0)
        box.key.setValue(settings.key ?? 60)
    })
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
        box.duration.setValue(duration)
        box.pitch.setValue(pitch)
        box.velocity.setValue(0.8)
        box.cent.setValue(0)
    })
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
    return {filter, level, edit, close: () => sync.close()}
}

const HELD = 200_000

const levelOf = async (pitch: number, settings: Settings): Promise<number> => {
    const scene = await createScene(pitch, HELD, settings)
    const level = scene.level(50)
    scene.close()
    return level
}

describe("Note Filter", () => {
    it("passes every key unchanged by default", async () => {
        expect(await levelOf(60, {})).toBeCloseTo(0.060, 6)
        expect(await levelOf(127, {})).toBeCloseTo(0.127, 6)
    }, 60000)
    it("passes min and max, both included", async () => {
        expect(await levelOf(36, {min: 36, max: 38})).toBeCloseTo(0.036, 6)
        expect(await levelOf(38, {min: 36, max: 38})).toBeCloseTo(0.038, 6)
        expect(await levelOf(35, {min: 36, max: 38})).toBe(0)
        expect(await levelOf(39, {min: 36, max: 38})).toBe(0)
    }, 60000)
    it("passes nothing when min is above max", async () => {
        expect(await levelOf(60, {min: 70, max: 50})).toBe(0)
    }, 60000)
    it("adds the transpose", async () => {
        expect(await levelOf(60, {transpose: 7})).toBeCloseTo(0.067, 6)
        expect(await levelOf(60, {transpose: -60})).toBe(0)
        expect(await levelOf(61, {transpose: -60})).toBeCloseTo(0.001, 6)
    }, 60000)
    it("ignores a transposed key outside 0 to 127", async () => {
        expect(await levelOf(60, {transpose: 68})).toBe(0)
        expect(await levelOf(60, {transpose: -61})).toBe(0)
        expect(await levelOf(60, {transpose: 67})).toBeCloseTo(0.127, 6)
    }, 60000)
    it("sets every passing key to the key and ignores the transpose", async () => {
        expect(await levelOf(40, {set: true, key: 72, transpose: 5})).toBeCloseTo(0.072, 6)
        expect(await levelOf(40, {set: true, key: 72, min: 41})).toBe(0)
    }, 60000)
    it("ends the note on its release", async () => {
        const scene = await createScene(60, 480, {set: true, key: 50})
        expect(scene.level(20)).toBeCloseTo(0.050, 6)
        expect(scene.level(400)).toBe(0)
        scene.close()
    }, 60000)
    it("ends a held note on its release after the settings changed", async () => {
        const scene = await createScene(60, 1920, {transpose: 12})
        expect(scene.level(20)).toBeCloseTo(0.072, 6)
        await scene.edit(() => {
            scene.filter.transpose.setValue(0)
            scene.filter.min.setValue(100)
        })
        expect(scene.level(20)).toBeCloseTo(0.072, 6)
        expect(scene.level(800)).toBe(0)
        scene.close()
    }, 60000)
    it("disabling ends the notes it passed and enabling again starts clean", async () => {
        const scene = await createScene(60, HELD, {set: true, key: 48})
        expect(scene.level(50)).toBeCloseTo(0.048, 6)
        await scene.edit(() => scene.filter.enabled.setValue(false))
        expect(scene.level(50)).toBe(0)
        await scene.edit(() => scene.filter.enabled.setValue(true))
        expect(scene.level(50)).toBe(0)
        scene.close()
    }, 60000)
})
