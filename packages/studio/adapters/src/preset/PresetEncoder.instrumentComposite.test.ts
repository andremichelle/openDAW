import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {
    AudioUnitBox, CaptureMidiBox, DelayDeviceBox, InstrumentCompositeBox, InstrumentCompositeCellBox, NanoDeviceBox,
    PitchDeviceBox, VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType, IconSymbol} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitFactory} from "../factories/AudioUnitFactory"
import {InstrumentFactories} from "../factories/InstrumentFactories"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"

// A unit whose instrument is an Instrument Composite must round-trip its whole subtree through a preset: the
// layers, each layer's instrument, both of its effect chains, and a composite NESTED inside a layer. Every device
// must stay hosted by ITS layer, never re-hosted onto the unit.
const PAD = -1.0
const STACK = -2.0
const DEEP = -3.0

describe("PresetEncoder / PresetDecoder (instrument composite subtree)", () => {
    const createUnit = (skeleton: ProjectSkeleton): AudioUnitBox =>
        AudioUnitFactory.create(skeleton, AudioUnitType.Instrument,
            Option.wrap(CaptureMidiBox.create(skeleton.boxGraph, UUID.generate())))

    const encodeCompositeUnit = (): ArrayBuffer => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const unit = createUnit(source)
        const composite = InstrumentFactories.InstrumentComposite.create(boxGraph, unit.input, "Layers", IconSymbol.Stack)
        // A layer has no name, so each one is tagged by a unique gain: Pad -1, Stack -2, Deep -3.
        const layer = (owner: InstrumentCompositeBox, index: number, gain: number) =>
            InstrumentCompositeCellBox.create(boxGraph, UUID.generate(), box => {
                box.composite.refer(owner.cells)
                box.index.setValue(index)
                box.gain.setValue(gain)
            })
        const pad = layer(composite, 0, PAD)
        InstrumentFactories.Vaporisateur.create(boxGraph, pad.instrument, "Pad synth", IconSymbol.Piano)
        PitchDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(pad.midiEffects); box.index.setValue(0)})
        DelayDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(pad.audioEffects); box.index.setValue(0)})
        const stack = layer(composite, 1, STACK)
        const inner = InstrumentFactories.InstrumentComposite.create(boxGraph, stack.instrument, "Inner", IconSymbol.Stack)
        const deep = layer(inner, 0, DEEP)
        InstrumentFactories.Nano.create(boxGraph, deep.instrument, "Deep nano", IconSymbol.Piano)
        DelayDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(unit.audioEffects); box.index.setValue(0)})
        boxGraph.endTransaction()
        return PresetEncoder.encode(unit) as ArrayBuffer
    }

    const hostOf = (box: Box & {host: {targetVertex: Option<{box: Box}>}}): Box => box.host.targetVertex.unwrap("host").box

    it("decodes into a new unit with every layer and every device in its own layer", () => {
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const [unit] = PresetDecoder.decode(encodeCompositeUnit(), target)
        boxGraph.endTransaction()
        const boxes = boxGraph.boxes()
        const composites = boxes.filter(box => box instanceof InstrumentCompositeBox)
        expect(composites.map(box => box.label.getValue()).toSorted()).toStrictEqual(["Inner", "Layers"])
        const outer = composites.find(box => box.label.getValue() === "Layers")!
        const inner = composites.find(box => box.label.getValue() === "Inner")!
        expect(hostOf(outer), "the outer composite is the unit's instrument").toBe(unit)
        const cells = boxes.filter(box => box instanceof InstrumentCompositeCellBox)
        const cell = (gain: number) => cells.find(box => box.gain.getValue() === gain)!
        expect(cells.map(box => [box.gain.getValue(), box.index.getValue()]).toSorted(([a], [b]) => b - a))
            .toStrictEqual([[PAD, 0], [STACK, 1], [DEEP, 0]])
        expect(cell(PAD).composite.targetVertex.unwrap("pad.composite").box).toBe(outer)
        expect(cell(STACK).composite.targetVertex.unwrap("stack.composite").box).toBe(outer)
        expect(cell(DEEP).composite.targetVertex.unwrap("deep.composite").box).toBe(inner)
        expect(hostOf(inner), "the nested composite stays inside its layer").toBe(cell(STACK))
        expect(hostOf(boxes.find(box => box instanceof VaporisateurDeviceBox)!)).toBe(cell(PAD))
        expect(hostOf(boxes.find(box => box instanceof PitchDeviceBox)!)).toBe(cell(PAD))
        expect(hostOf(boxes.find(box => box instanceof NanoDeviceBox)!)).toBe(cell(DEEP))
        const delayHosts = boxes.filter(box => box instanceof DelayDeviceBox).map(hostOf)
        expect(delayHosts.length).toBe(2)
        expect(delayHosts).toContain(cell(PAD))
        expect(delayHosts, "the unit-level delay stays on the unit").toContain(unit)
    })

    it("replaces a plain unit's instrument with the whole composite", () => {
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const unit = createUnit(target)
        InstrumentFactories.Nano.create(boxGraph, unit.input, "Old", IconSymbol.Piano)
        const attempt = PresetDecoder.replaceAudioUnit(encodeCompositeUnit(), unit)
        boxGraph.endTransaction()
        expect(attempt.isSuccess(), attempt.isFailure() ? String(attempt.failureReason()) : "").toBe(true)
        const inputs = unit.input.pointerHub.incoming().map(pointer => pointer.box)
        expect(inputs.length).toBe(1)
        expect(inputs[0]).toBeInstanceOf(InstrumentCompositeBox)
        expect(boxGraph.boxes().filter(box => box instanceof InstrumentCompositeCellBox).length).toBe(3)
        expect(boxGraph.boxes().filter(box => box instanceof NanoDeviceBox).map(box => box.label.getValue()))
            .toStrictEqual(["Deep nano"])
    })

    it("a single layer instrument saves as an ordinary instrument preset", () => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        source.boxGraph.beginTransaction()
        const sourceUnit = createUnit(source)
        const composite = InstrumentFactories.InstrumentComposite.create(source.boxGraph, sourceUnit.input, "Layers", IconSymbol.Stack)
        const cell = InstrumentCompositeCellBox.create(source.boxGraph, UUID.generate(), box => {
            box.composite.refer(composite.cells)
            box.index.setValue(0)
        })
        const synth = InstrumentFactories.Vaporisateur.create(source.boxGraph, cell.instrument, "Layer lead", IconSymbol.Piano)
        synth.cutoff.setValue(0.25)
        DelayDeviceBox.create(source.boxGraph, UUID.generate(), box => {box.host.refer(cell.audioEffects); box.index.setValue(0)})
        source.boxGraph.endTransaction()
        const bytes = PresetEncoder.encodeLayerInstrument(synth) as ArrayBuffer
        // Onto a plain unit, like any instrument preset.
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        target.boxGraph.beginTransaction()
        const unit = createUnit(target)
        InstrumentFactories.Nano.create(target.boxGraph, unit.input, "Old", IconSymbol.Piano)
        const attempt = PresetDecoder.replaceAudioUnit(bytes, unit, {keepMIDIEffects: true, keepAudioEffects: true, keepTimeline: true})
        target.boxGraph.endTransaction()
        expect(attempt.isSuccess(), attempt.isFailure() ? String(attempt.failureReason()) : "").toBe(true)
        const [loaded] = unit.input.pointerHub.incoming().map(pointer => pointer.box)
        expect(loaded).toBeInstanceOf(VaporisateurDeviceBox)
        expect([(loaded as VaporisateurDeviceBox).label.getValue(), (loaded as VaporisateurDeviceBox).cutoff.getValue()])
            .toStrictEqual(["Layer lead", 0.25])
        const names = target.boxGraph.boxes().map(box => box.name)
        expect(names, "the composite, its layer and the layer's effects stay behind")
            .not.toContain("InstrumentCompositeBox")
        expect(names).not.toContain("InstrumentCompositeCellBox")
        expect(names).not.toContain("DelayDeviceBox")
        // And back into another layer.
        const other = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        other.boxGraph.beginTransaction()
        const otherUnit = createUnit(other)
        const otherComposite = InstrumentFactories.InstrumentComposite.create(other.boxGraph, otherUnit.input, "Layers", IconSymbol.Stack)
        const otherCell = InstrumentCompositeCellBox.create(other.boxGraph, UUID.generate(), box => {
            box.composite.refer(otherComposite.cells)
            box.index.setValue(0)
        })
        const intoLayer = PresetDecoder.replaceLayerInstrument(bytes, otherCell)
        other.boxGraph.endTransaction()
        expect(intoLayer.isSuccess()).toBe(true)
        expect(otherCell.instrument.pointerHub.incoming().map(pointer => pointer.box.name)).toStrictEqual(["VaporisateurDeviceBox"])
    })

    it("every listed instrument box maps back to its factory key", () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        skeleton.boxGraph.beginTransaction()
        const keys = Object.entries(InstrumentFactories.Named).map(([key, factory]) => {
            const unit = createUnit(skeleton)
            return [key, InstrumentFactories.keyOfBox(factory.create(skeleton.boxGraph, unit.input, key, IconSymbol.Piano))]
        })
        skeleton.boxGraph.endTransaction()
        expect(keys.filter(([key, resolved]) => key !== resolved), "box names that do not resolve to their key")
            .toStrictEqual([])
        expect(InstrumentFactories.keyOfBox(skeleton.mandatoryBoxes.rootBox)).toBeUndefined()
    })
})
