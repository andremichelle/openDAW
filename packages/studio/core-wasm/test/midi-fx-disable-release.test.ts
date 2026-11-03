// Disabling a MIDI effect must stop every note it started. The instrument is an Apparat script WITHOUT a reset(),
// so only a note-off ends its voice: it outputs DC 0.3 while any voice is held. A long track note feeds the effect.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, ArpeggioDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SpielwerkDeviceBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const INSTRUMENT = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += 0.3; r[i] += 0.3 } }
    }
}`

// yields one long note per incoming note, @no-pass so the track note itself never reaches the instrument
const GENERATOR = `// @no-pass
class Processor {
    * process(block, events) {
        for (const event of events) {
            if (event.gate) { yield {position: event.position, duration: 100000, pitch: event.pitch + 12, velocity: 0.8} }
        }
    }
}`

type Effect = "arpeggio" | "spielwerk"

const run = async (effect: Effect, reEnable: boolean): Promise<{before: number, after: number, again: number}> => {
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
    const fx = effect === "arpeggio"
        ? ArpeggioDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.rateIndex.setValue(9)
            box.gate.setValue(1.0)
        })
        : SpielwerkDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.code.setValue("// @spielwerk js 1 1\n" + GENERATOR)
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
        box.duration.setValue(200_000)
        box.pitch.setValue(60)
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
    if (effect === "spielwerk") {
        new Function(ScriptCompiler.wrap(
            {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"},
            UUID.toString(fx.address.uuid), 1, GENERATOR))()
    }
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
    engine.stop(); engine.play()
    const before = level(200)
    source.beginTransaction(); fx.enabled.setValue(false); source.endTransaction()
    await sync.settle()
    const after = level(200)
    let again = after
    if (reEnable) {
        // the track note is still held but its start is long gone, so a clean effect has nothing to play
        source.beginTransaction(); fx.enabled.setValue(true); source.endTransaction()
        await sync.settle()
        again = level(200)
    }
    sync.close()
    return {before, after, again}
}

describe("disabling a MIDI effect releases its notes", () => {
    it("Arpeggio", async () => {
        const {before, after} = await run("arpeggio", false)
        expect(before).toBeGreaterThan(0.1)
        expect(after).toBe(0)
    }, 60000)
    it("Arpeggio enabled again starts clean", async () => {
        const {again} = await run("arpeggio", true)
        expect(again).toBe(0)
    }, 60000)
    it("Spielwerk", async () => {
        const {before, after} = await run("spielwerk", false)
        expect(before).toBeGreaterThan(0.1)
        expect(after).toBe(0)
    }, 60000)
})
