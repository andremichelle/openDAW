import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {IconSymbol, AudioUnitType} from "@opendaw/studio-enums"
import {
    AudioUnitBox, DelayDeviceBox, InstrumentCompositeBox, InstrumentCompositeCellBox, NanoDeviceBox, NeonDeviceBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {InstrumentFactories} from "../factories/InstrumentFactories"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"

// A preset applied INSIDE a layer of an Instrument Composite replaces that layer's instrument only. It used to
// go through `replaceAudioUnit`, which swapped the unit's instrument, i.e. the whole composite.
describe("PresetDecoder.replaceLayerInstrument", () => {
    const createUnit = (target: ProjectSkeleton): AudioUnitBox => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        return AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
    }

    // A Neon preset whose unit also carries a Delay, which must NOT travel into the layer.
    const neonPreset = (): ArrayBuffer => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        source.boxGraph.beginTransaction()
        const unit = createUnit(source)
        const neon = InstrumentFactories.Neon.create(source.boxGraph, unit.input, "Preset Neon", IconSymbol.Piano)
        DelayDeviceBox.create(source.boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
        neon.label.setValue("Glass Bells")
        source.boxGraph.endTransaction()
        return PresetEncoder.encode(unit) as ArrayBuffer
    }

    const compositeProject = () => {
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const unit = createUnit(target)
        const composite = InstrumentFactories.InstrumentComposite.create(boxGraph, unit.input, "Layers", IconSymbol.Stack)
        const layers = [InstrumentFactories.Neon, InstrumentFactories.Vaporisateur].map((factory, index) => {
            const cell = InstrumentCompositeCellBox.create(boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.cells)
                box.index.setValue(index)
                box.gain.setValue(-6.0)
            })
            factory.create(boxGraph, cell.instrument, factory.defaultName, factory.defaultIcon)
            return cell
        })
        const layerDelay = DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(layers[0].audioEffects)
            box.index.setValue(0)
        })
        boxGraph.endTransaction()
        return {target, unit, composite, layers, layerDelay}
    }

    const instrumentOf = (cell: InstrumentCompositeCellBox) => cell.instrument.pointerHub.incoming().map(pointer => pointer.box)

    it("replaces the layer's instrument and nothing else", () => {
        const {target, unit, composite, layers, layerDelay} = compositeProject()
        const {boxGraph} = target
        const oldNeon = instrumentOf(layers[0])[0]
        boxGraph.beginTransaction()
        const result = PresetDecoder.replaceLayerInstrument(neonPreset(), layers[0])
        boxGraph.endTransaction()
        expect(result.isSuccess(), result.isFailure() ? String(result.failureReason()) : "").toBe(true)
        expect(composite.isAttached(), "the composite survives").toBe(true)
        expect(unit.input.pointerHub.incoming().map(pointer => pointer.box)).toStrictEqual([composite])
        expect(composite.cells.pointerHub.incoming().length, "both layers survive").toBe(2)
        const [replaced] = instrumentOf(layers[0])
        expect(instrumentOf(layers[0]).length).toBe(1)
        expect(replaced).toBeInstanceOf(NeonDeviceBox)
        expect((replaced as NeonDeviceBox).label.getValue()).toBe("Glass Bells")
        expect(oldNeon.isAttached(), "the old instrument is gone").toBe(false)
        expect([layers[0].index.getValue(), layers[0].gain.getValue()], "the layer keeps its place and strip")
            .toStrictEqual([0, -6.0])
        expect(layers[0].audioEffects.pointerHub.incoming().map(pointer => pointer.box), "the layer keeps its effects")
            .toStrictEqual([layerDelay])
        expect(instrumentOf(layers[1])[0]).toBeInstanceOf(VaporisateurDeviceBox)
        expect(boxGraph.boxes().filter(box => box instanceof AudioUnitBox).length, "no preset unit is grafted in")
            .toBe(2)
        expect(boxGraph.boxes().filter(box => box instanceof DelayDeviceBox), "the preset's unit effects stay out")
            .toStrictEqual([layerDelay])
    })

    it("a preset of another instrument type changes the layer's instrument type", () => {
        const {target, layers} = compositeProject()
        target.boxGraph.beginTransaction()
        const result = PresetDecoder.replaceLayerInstrument(neonPreset(), layers[1])
        target.boxGraph.endTransaction()
        expect(result.isSuccess()).toBe(true)
        expect(instrumentOf(layers[1]).map(box => box.name)).toStrictEqual(["NeonDeviceBox"])
    })

    it("refuses an instrument that cannot live in a layer", () => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        source.boxGraph.beginTransaction()
        const tapeUnit = createUnit(source)
        InstrumentFactories.Tape.create(source.boxGraph, tapeUnit.input, "Tape", IconSymbol.Tape)
        source.boxGraph.endTransaction()
        const {target, layers} = compositeProject()
        const before = instrumentOf(layers[0])[0]
        target.boxGraph.beginTransaction()
        const result = PresetDecoder.replaceLayerInstrument(PresetEncoder.encode(tapeUnit) as ArrayBuffer, layers[0])
        target.boxGraph.endTransaction()
        expect(result.isFailure()).toBe(true)
        expect(instrumentOf(layers[0]), "a refused preset changes nothing").toStrictEqual([before])
    })

    it("an emptied layer takes the preset's instrument", () => {
        const {target, layers} = compositeProject()
        target.boxGraph.beginTransaction()
        instrumentOf(layers[0]).forEach(box => box.delete())
        const result = PresetDecoder.replaceLayerInstrument(neonPreset(), layers[0])
        target.boxGraph.endTransaction()
        expect(result.isSuccess()).toBe(true)
        expect(instrumentOf(layers[0]).map(box => box.name)).toStrictEqual(["NeonDeviceBox"])
        expect(NanoDeviceBox).toBeDefined()
        expect(InstrumentCompositeBox).toBeDefined()
    })
})
