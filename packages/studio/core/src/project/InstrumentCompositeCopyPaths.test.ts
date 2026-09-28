import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {
    AudioUnitBox, CaptureMidiBox, DelayDeviceBox, InstrumentCompositeBox, InstrumentCompositeCellBox, NanoDeviceBox,
    PitchDeviceBox, VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType, IconSymbol} from "@opendaw/studio-enums"
import {AudioUnitFactory, InstrumentFactories, ProjectSkeleton, TransferAudioUnits} from "@opendaw/studio-adapters"
import {DevicesClipboard} from "../ui/clipboard/types/DevicesClipboardHandler"

// The copy paths carry no per-box code, they walk the graph's dependencies. These tests pin what that walk
// does with an Instrument Composite: a whole unit travels complete, ONE effect out of a layer travels alone.
const PAD = -1.0
const STACK = -2.0
const DEEP = -3.0

describe("Instrument Composite copy paths", () => {
    const build = () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = skeleton
        boxGraph.beginTransaction()
        const unit = AudioUnitFactory.create(skeleton, AudioUnitType.Instrument,
            Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate())))
        const composite = InstrumentFactories.InstrumentComposite.create(boxGraph, unit.input, "Layers", IconSymbol.Stack)
        // A layer has no name, so each one is tagged by a unique gain.
        const layer = (owner: InstrumentCompositeBox, index: number, gain: number) =>
            InstrumentCompositeCellBox.create(boxGraph, UUID.generate(), box => {
                box.composite.refer(owner.cells)
                box.index.setValue(index)
                box.gain.setValue(gain)
            })
        const pad = layer(composite, 0, PAD)
        InstrumentFactories.Vaporisateur.create(boxGraph, pad.instrument, "Pad synth", IconSymbol.Piano)
        const padDelay = DelayDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(pad.audioEffects); box.index.setValue(0)})
        PitchDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(pad.midiEffects); box.index.setValue(0)})
        const stack = layer(composite, 1, STACK)
        const inner = InstrumentFactories.InstrumentComposite.create(boxGraph, stack.instrument, "Inner", IconSymbol.Stack)
        InstrumentFactories.Nano.create(boxGraph, layer(inner, 0, DEEP).instrument, "Deep nano", IconSymbol.Piano)
        boxGraph.endTransaction()
        return {skeleton, unit, padDelay}
    }

    const hostOf = (box: Box & {host: {targetVertex: Option<{box: Box}>}}): Box => box.host.targetVertex.unwrap("host").box

    it("a composite unit transfers into another project with every device in its own layer", () => {
        const {unit} = build()
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        target.boxGraph.beginTransaction()
        const [copied] = TransferAudioUnits.transfer([unit], target)
        target.boxGraph.endTransaction()
        const boxes = target.boxGraph.boxes()
        const cells = boxes.filter(box => box instanceof InstrumentCompositeCellBox)
        const cell = (gain: number) => cells.find(box => box.gain.getValue() === gain)!
        expect(cells.map(box => box.gain.getValue()).toSorted((a, b) => b - a)).toStrictEqual([PAD, STACK, DEEP])
        const composites = boxes.filter(box => box instanceof InstrumentCompositeBox)
        const outer = composites.find(box => box.label.getValue() === "Layers")!
        const inner = composites.find(box => box.label.getValue() === "Inner")!
        expect(hostOf(outer)).toBe(copied)
        expect(hostOf(inner)).toBe(cell(STACK))
        expect(hostOf(boxes.find(box => box instanceof VaporisateurDeviceBox)!)).toBe(cell(PAD))
        expect(hostOf(boxes.find(box => box instanceof DelayDeviceBox)!)).toBe(cell(PAD))
        expect(hostOf(boxes.find(box => box instanceof PitchDeviceBox)!)).toBe(cell(PAD))
        expect(hostOf(boxes.find(box => box instanceof NanoDeviceBox)!)).toBe(cell(DEEP))
        expect(boxes.filter(box => box instanceof AudioUnitBox && box.type.getValue() !== AudioUnitType.Output).length).toBe(1)
    })

    it("copying ONE effect out of a layer does not drag the layer, the composite or its siblings along", () => {
        const {skeleton, padDelay} = build()
        const dependencies = DevicesClipboard.collectDeviceDependencies([padDelay], skeleton.boxGraph)
        const names = dependencies.map(box => box.name)
        expect(names).not.toContain("InstrumentCompositeCellBox")
        expect(names).not.toContain("InstrumentCompositeBox")
        expect(names).not.toContain("VaporisateurDeviceBox")
        expect(names).not.toContain("PitchDeviceBox")
        expect(names).not.toContain("AudioUnitBox")
    })
})
