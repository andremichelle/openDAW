// Regression #1: a device that resolves a parameter by matching `ParamValue` ITSELF (Tidal's rate is a
// fraction INDEX carried on a float field, so neither `float_value` nor `int_value` can serve it) used to
// have no `Modulated` arm and panicked the first time a modulator drove it. Devices are built with
// `-Cpanic=immediate-abort`, so that panic reaches the studio as a bare, message-less "RuntimeError:
// unreachable" (packages/studio/core-wasm/build-wasm.sh).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox,
    AudioUnitBox,
    LfoModulatorBox,
    ModulationBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TidalDeviceBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const DC = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += 0.3; r[i] += 0.3 } }
    }
}`

describe("modulated tidal rate", () => {
    it("an LFO on the rate index renders instead of trapping", async () => {
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
            box.code.setValue("// @apparat js 1 1\n" + DC)
        })
        const tidal = TidalDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.depth.setValue(1.0)
        })
        const notes = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(0)
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
            box.regions.refer(notes.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(200_000)
            box.loopDuration.setValue(200_000)
        })
        const lfo = LfoModulatorBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Rate")
        })
        ModulationBox.create(source, UUID.generate(), box => {
            box.source.refer(lfo.assignments)
            box.target.refer(tidal.rate)
            box.depth.setValue(1.0)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, DC))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle()
        engine.bind()
        await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop()
        engine.play()
        const half = (engine.output_len() >>> 0) >>> 1
        let peak = 0
        for (let quantum = 0; quantum < 200; quantum++) {
            engine.render()
            const output = new Float32Array(memory.buffer, engine.output_ptr(), half)
            for (const sample of output) {
                expect(Number.isFinite(sample)).toBe(true)
                peak = Math.max(peak, Math.abs(sample))
            }
        }
        expect(peak).toBeGreaterThan(0.0)
    })
})
