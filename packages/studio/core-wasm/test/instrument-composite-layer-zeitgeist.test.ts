// A Zeitgeist INSIDE one layer of an Instrument Composite shifts only that layer. Layer A (left channel) has
// the groove in its own midi chain, layer B (right channel) has none, both read the same note at pulse 240.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox, AudioUnitBox, GrooveShuffleBox, InstrumentCompositeBox, InstrumentCompositeCellBox,
    NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLE_RATE = 48000
const SAMPLES_PER_PULSE = SAMPLE_RATE / (120.0 / 60.0 * 960.0)

const code = (left: number, right: number) => `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += ${left}; r[i] += ${right} } }
    }
}`

describe("instrument composite with a Zeitgeist inside one layer", () => {
    it("shifts that layer only", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const composite = InstrumentCompositeBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const cells = [code(0.3, 0.0), code(0.0, 0.3)].map((script, index) => {
            const cell = InstrumentCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.cells)
                box.index.setValue(index)
            })
            const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(cell.instrument)
                box.code.setValue("// @apparat js 1 1\n" + script)
            })
            new Function(ScriptCompiler.wrap(
                {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
                UUID.toString(apparat.address.uuid), 1, script))()
            return cell
        })
        const grooveBox = GrooveShuffleBox.create(source, UUID.generate(), box => {
            box.label.setValue("Shuffle")
            box.duration.setValue(480)
            box.amount.setValue(0.6)
        })
        ZeitgeistDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(cells[0].midiEffects)
            box.groove.refer(grooveBox)
            box.index.setValue(0)
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
            box.position.setValue(240)
            box.duration.setValue(240)
            box.pitch.setValue(60)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(3840)
            box.loopDuration.setValue(3840)
        })
        source.endTransaction()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const half = (engine.output_len() >>> 0) >>> 1
        engine.stop(); engine.play()
        const quanta = Math.ceil(0.5 * SAMPLE_RATE / half)
        const left = new Float32Array(quanta * half)
        const right = new Float32Array(quanta * half)
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            const enginePtr = engine.output_ptr()
            left.set(new Float32Array(memory.buffer, enginePtr, half), quantum * half)
            right.set(new Float32Array(memory.buffer, enginePtr + half * 4, half), quantum * half)
        }
        const grooved = left.findIndex(value => value > 0.1)
        const straight = right.findIndex(value => value > 0.1)
        expect(straight, "the plain layer must be audible").toBeGreaterThan(0)
        expect(grooved, "the grooved layer must be audible").toBeGreaterThan(0)
        expect(Math.abs(straight - 240 * SAMPLES_PER_PULSE), `straight onset ${straight}`).toBeLessThan(64)
        expect(grooved - straight, "only the layer with the Zeitgeist swings later").toBeGreaterThan(600)
        sync.close()
    }, 60000)
})
