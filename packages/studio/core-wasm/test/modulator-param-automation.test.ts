// Every MODULATOR parameter must survive its own automation. The engine folds these in `BoundParam::refresh`,
// picking the resolver from a mapping table in the engine (`modulator_params`) while the wire kind comes from
// the box SCHEMA: an integer mapping over a float field (or the reverse) panics there, and a device/engine
// panic reaches the studio as a bare "RuntimeError: unreachable". So automate EVERY parameter of EVERY
// modulator kind at once, with the modulator itself driving a live target.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {Field} from "@opendaw/lib-box"
import {Interpolation} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBox,
    AudioUnitBox,
    LfoModulatorBox,
    MacroModulatorBox,
    ModulationBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    RandomModulatorBox,
    StepsModulatorBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
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

const SWEEP = 4800

describe("modulator parameter automation", () => {
    it("every parameter of every modulator kind renders while automated", async () => {
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
        const notes = TrackBox.create(source, UUID.generate(), box => {
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
            box.regions.refer(notes.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(200_000)
            box.loopDuration.setValue(200_000)
        })
        // A value track sweeping the whole range of one modulator parameter, so every mapping is exercised
        // from end to end (an integer mapping snaps, a power one spans its curve).
        const automate = (target: Field, tracks: Field, index: number) => {
            const track = TrackBox.create(source, UUID.generate(), box => {
                box.type.setValue(TrackType.Value)
                box.enabled.setValue(true)
                box.index.setValue(index)
                box.target.refer(target)
                box.tracks.refer(tracks)
            })
            const collection = ValueEventCollectionBox.create(source, UUID.generate())
            const event = (position: number, value: number, order: number) =>
                ValueEventBox.create(source, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.value.setValue(value)
                    box.index.setValue(order)
                    box.slope.setValue(NaN)
                    box.events.refer(collection.events)
                    InterpolationFieldAdapter.write(box.interpolation, Interpolation.Linear)
                })
            event(0, 0.0, 0)
            event(SWEEP, 1.0, 1)
            ValueRegionBox.create(source, UUID.generate(), box => {
                box.regions.refer(track.regions)
                box.events.refer(collection.owners)
                box.position.setValue(0)
                box.duration.setValue(SWEEP)
                box.loopDuration.setValue(SWEEP)
            })
        }
        const lfo = LfoModulatorBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Lfo")
        })
        const steps = StepsModulatorBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Steps")
        })
        const random = RandomModulatorBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Random")
        })
        const macro = MacroModulatorBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.modulators)
            box.label.setValue("Macro")
        })
        const parameters: ReadonlyArray<readonly [typeof lfo | typeof steps | typeof random | typeof macro,
            ReadonlyArray<Field>]> = [
            [lfo, [lfo.shape, lfo.rateSync, lfo.rateAbsolute, lfo.phase, lfo.amount, lfo.exponent]],
            // count / direction / loop / seed / levels are plain fields, not parameters.
            [steps, [steps.rateSync, steps.rateAbsolute, steps.phase, steps.amount, steps.smooth]],
            [random, [random.rateSync, random.rateAbsolute, random.phase, random.amount, random.smooth]],
            [macro, [macro.value]]
        ]
        parameters.forEach(([modulator, fields]) => {
            fields.forEach((field, index) => automate(field, modulator.tracks, index))
            // Each modulator drives a live target, so its own parameters are bound and refreshed per quantum.
            ModulationBox.create(source, UUID.generate(), box => {
                box.source.refer(modulator.assignments)
                box.target.refer(unit.volume)
                box.depth.setValue(0.25)
            })
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
        for (let quantum = 0; quantum < 400; quantum++) {
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
