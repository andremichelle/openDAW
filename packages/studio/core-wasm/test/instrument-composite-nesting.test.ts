// A layer of an Instrument Composite may host another composite: a Playfield, or another Instrument Composite.
// Layer B is always an Apparat with DC on the RIGHT channel, the nested content sounds on the LEFT.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {
    ApparatDeviceBox, AudioFileBox, AudioUnitBox, BoxIO, InstrumentCompositeBox, InstrumentCompositeCellBox,
    NoteEventBox, NoteEventCollectionBox, NoteRegionBox, PlayfieldDeviceBox, PlayfieldSampleBox, TrackBox
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

type Graph = BoxGraph<BoxIO.TypeMap>

const createApparat = (graph: Graph, cell: InstrumentCompositeCellBox, script: string): void => {
    const apparat = ApparatDeviceBox.create(graph, UUID.generate(), box => {
        box.host.refer(cell.instrument)
        box.code.setValue("// @apparat js 1 1\n" + script)
    })
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, script))()
}

const createCell = (graph: Graph, composite: InstrumentCompositeBox, index: number): InstrumentCompositeCellBox =>
    InstrumentCompositeCellBox.create(graph, UUID.generate(), box => {
        box.composite.refer(composite.cells)
        box.index.setValue(index)
    })

const peaks = async (fillLayerA: (graph: Graph, cell: InstrumentCompositeCellBox) => void): Promise<{left: number, right: number}> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const composite = InstrumentCompositeBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    fillLayerA(source, createCell(source, composite, 0))
    createApparat(source, createCell(source, composite, 1), code(0.0, 0.25))
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
    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    drainSamples()
    await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    let left = 0.0
    let right = 0.0
    for (let quantum = 0; quantum < 100; quantum++) {
        engine.render()
        const pointer = engine.output_ptr()
        new Float32Array(memory.buffer, pointer, half).forEach(value => left = Math.max(left, Math.abs(value)))
        new Float32Array(memory.buffer, pointer + half * 4, half).forEach(value => right = Math.max(right, Math.abs(value)))
    }
    sync.close()
    return {left, right}
}

describe("instrument composite nesting", () => {
    it("a layer hosts a Playfield", async () => {
        const {left, right} = await peaks((graph, cell) => {
            const playfield = PlayfieldDeviceBox.create(graph, UUID.generate(), box => box.host.refer(cell.instrument))
            const file = AudioFileBox.create(graph, UUID.generate(), box => {
                box.startInSeconds.setValue(0.0)
                box.endInSeconds.setValue(1.0)
                box.fileName.setValue("synthetic")
            })
            PlayfieldSampleBox.create(graph, UUID.generate(), box => {
                box.device.refer(playfield.samples)
                box.file.refer(file)
                box.index.setValue(60)
                box.panning.setValue(-1.0)
            })
        })
        expect(left, "the pad inside the layer sounds").toBeGreaterThan(0.2)
        expect(right, "the plain layer sounds").toBeCloseTo(0.25, 3)
    }, 60000)

    it("a layer hosts another Instrument Composite", async () => {
        const {left, right} = await peaks((graph, cell) => {
            const inner = InstrumentCompositeBox.create(graph, UUID.generate(), box => box.host.refer(cell.instrument))
            createApparat(graph, createCell(graph, inner, 0), code(0.125, 0.0))
            createApparat(graph, createCell(graph, inner, 1), code(0.125, 0.0))
        })
        expect(left, "both inner layers sum on the left").toBeCloseTo(0.25, 3)
        expect(right).toBeCloseTo(0.25, 3)
    }, 60000)

    it("the hosting layer's strip scales the whole nested composite", async () => {
        const {left, right} = await peaks((graph, cell) => {
            cell.gain.setValue(-6.0)
            const inner = InstrumentCompositeBox.create(graph, UUID.generate(), box => box.host.refer(cell.instrument))
            createApparat(graph, createCell(graph, inner, 0), code(0.25, 0.0))
        })
        expect(left).toBeCloseTo(0.25 * Math.pow(10.0, -6.0 / 20.0), 2)
        expect(right).toBeCloseTo(0.25, 3)
    }, 60000)
})
