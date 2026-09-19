// The per-layer strip of an Instrument Composite, audible through the real engine.wasm. Layer A outputs DC on
// the LEFT channel only, layer B on the RIGHT only, so each channel's level is one layer's level.
import {describe, expect, it} from "vitest"
import {Procedure, UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox, AudioUnitBox, InstrumentCompositeBox, InstrumentCompositeCellBox, NoteEventBox,
    NoteEventCollectionBox, NoteRegionBox, TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const code = (left: number, right: number) => `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += ${left}; r[i] += ${right} } }
    }
}`

type Layers = [InstrumentCompositeCellBox, InstrumentCompositeCellBox]
type Levels = { left: number, right: number }

const levels = async (configure: Procedure<Layers>): Promise<Levels> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const composite = InstrumentCompositeBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const cells = [code(0.25, 0.0), code(0.0, 0.25)].map((script, index) => {
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
    }) as Layers
    configure(cells)
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
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    for (let quantum = 0; quantum < 200; quantum++) {engine.render()} // let the strip ramps settle
    const pointer = engine.output_ptr()
    const left = new Float32Array(memory.buffer, pointer, half)[half - 1]
    const right = new Float32Array(memory.buffer, pointer + half * 4, half)[half - 1]
    sync.close()
    return {left, right}
}

describe("instrument composite layer strip", () => {
    it("two untouched layers sum at unity", async () => {
        const {left, right} = await levels(() => {})
        expect(left).toBeCloseTo(right, 5)
        expect(left).toBeGreaterThan(0.1)
    }, 60000)

    it("gain scales one layer only", async () => {
        const reference = await levels(() => {})
        const {left, right} = await levels(([layerA]) => layerA.gain.setValue(-6.0))
        expect(left / reference.left).toBeCloseTo(Math.pow(10.0, -6.0 / 20.0), 2)
        expect(right).toBeCloseTo(reference.right, 5)
    }, 60000)

    it("mute silences one layer only", async () => {
        const reference = await levels(() => {})
        const {left, right} = await levels(([layerA]) => layerA.mute.setValue(true))
        expect(Math.abs(left)).toBeLessThan(1e-4)
        expect(right).toBeCloseTo(reference.right, 5)
    }, 60000)

    it("solo silences the other layer", async () => {
        const reference = await levels(() => {})
        const {left, right} = await levels(([layerA]) => layerA.solo.setValue(true))
        expect(left).toBeCloseTo(reference.left, 5)
        expect(Math.abs(right)).toBeLessThan(1e-4)
    }, 60000)

    it("pan moves one layer", async () => {
        const reference = await levels(() => {})
        const {left, right} = await levels(([layerA]) => layerA.pan.setValue(1.0))
        expect(Math.abs(left)).toBeLessThan(1e-4)
        expect(right).toBeCloseTo(reference.right, 5)
    }, 60000)
})
