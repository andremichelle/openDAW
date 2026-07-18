import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {
    CaptureAudioBox,
    CrusherDeviceBox,
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
    StereoCompositeBox,
    StereoToolDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitFactory} from "../factories/AudioUnitFactory"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"
import {PresetHeader} from "./PresetHeader"

// A composite saved as an EFFECT CHAIN preset must round-trip its whole subtree: its entries, and each entry's
// own effects hosted BY THAT ENTRY. Those nested effects' `host` pointers are AudioEffectHost — the same pointer
// type the chain encoder/decoder re-target onto the destination chain — so re-targeting them unconditionally
// rips every nested effect out of its entry and flattens the composite (the #265 shape, one level down).
describe("PresetEncoder / PresetDecoder (composite subtree)", () => {
    const encodeCompositeChain = (): ArrayBuffer => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        const composite = AudioEffectCompositeBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
        const entryA = AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(composite.entries)
            box.index.setValue(0)
            box.label.setValue("A")
        })
        const entryB = AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(composite.entries)
            box.index.setValue(1)
            box.label.setValue("B")
        })
        StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(entryA.audioEffects))
        CrusherDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(entryB.audioEffects))
        boxGraph.endTransaction()
        return PresetEncoder.encodeEffects([composite], PresetHeader.ChainKind.Audio) as ArrayBuffer
    }

    it("keeps each entry's effects hosted by that entry, not flattened onto the target chain", () => {
        const bytes = encodeCompositeChain()
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const targetUnit = AudioUnitFactory.create(target, AudioUnitType.Instrument, Option.wrap(capture))
        const attempt = PresetDecoder.insertEffectChain(bytes, targetUnit, 0, PresetHeader.ChainKind.Audio)
        boxGraph.endTransaction()
        expect(attempt.isFailure()).toBe(false)
        // Exactly ONE composite, and it is what sits on the target unit's chain.
        const composites = boxGraph.boxes().filter(box => box instanceof AudioEffectCompositeBox)
        expect(composites.length).toBe(1)
        expect(composites[0].host.targetVertex.unwrap("composite.host").address)
            .toStrictEqual(targetUnit.audioEffects.address)
        const entries = boxGraph.boxes().filter(box => box instanceof AudioEffectCompositeCellBox)
        expect(entries.length).toBe(2)
        for (const entry of entries) {
            expect(entry.composite.targetVertex.unwrap("entry.composite").box).toBe(composites[0])
        }
        // Each nested effect is still hosted by its OWN entry — not re-hosted onto the unit's chain.
        const stereoTool = boxGraph.boxes().find(box => box instanceof StereoToolDeviceBox)
        const crusher = boxGraph.boxes().find(box => box instanceof CrusherDeviceBox)
        const stereoHost = stereoTool?.host.targetVertex.unwrap("stereoTool.host").box
        const crusherHost = crusher?.host.targetVertex.unwrap("crusher.host").box
        expect(stereoHost).toBeInstanceOf(AudioEffectCompositeCellBox)
        expect(crusherHost).toBeInstanceOf(AudioEffectCompositeCellBox)
        expect((stereoHost as AudioEffectCompositeCellBox).label.getValue()).toBe("A")
        expect((crusherHost as AudioEffectCompositeCellBox).label.getValue()).toBe("B")
    })

    // Decode a chain preset onto a fresh unit and return the target graph + unit.
    const decodeChain = (bytes: ArrayBuffer) => {
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const targetUnit = AudioUnitFactory.create(target, AudioUnitType.Instrument, Option.wrap(capture))
        const attempt = PresetDecoder.insertEffectChain(bytes, targetUnit, 0, PresetHeader.ChainKind.Audio)
        boxGraph.endTransaction()
        expect(attempt.isFailure(), "decode should succeed").toBe(false)
        return {boxGraph, targetUnit}
    }

    it("round-trips the composite's dry/wet and each entry's gain/pan/mute/solo values", () => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        const composite = AudioEffectCompositeBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.dry.setValue(-6.0)
            box.wet.setValue(-3.0)
        })
        AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(composite.entries)
            box.index.setValue(0)
            box.label.setValue("A")
            box.gain.setValue(-4.5)
            box.pan.setValue(0.5)
            box.mute.setValue(true)
            box.solo.setValue(true)
        })
        boxGraph.endTransaction()
        const bytes = PresetEncoder.encodeEffects([composite], PresetHeader.ChainKind.Audio) as ArrayBuffer
        const {boxGraph: targetGraph} = decodeChain(bytes)
        const pastedComposite = targetGraph.boxes()
            .find(box => box instanceof AudioEffectCompositeBox) as AudioEffectCompositeBox
        expect(pastedComposite.dry.getValue()).toBe(-6.0)
        expect(pastedComposite.wet.getValue()).toBe(-3.0)
        const pastedEntry = targetGraph.boxes()
            .find(box => box instanceof AudioEffectCompositeCellBox) as AudioEffectCompositeCellBox
        expect(pastedEntry.label.getValue()).toBe("A")
        expect(pastedEntry.gain.getValue()).toBe(-4.5)
        expect(pastedEntry.pan.getValue()).toBe(0.5)
        expect(pastedEntry.mute.getValue()).toBe(true)
        expect(pastedEntry.solo.getValue()).toBe(true)
    })

    it("round-trips a STEREO SPLIT with its two fixed entries and a nested effect", () => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        const split = StereoCompositeBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
        const left = AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(split.entries)
            box.index.setValue(0)
            box.label.setValue("L")
        })
        AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(split.entries)
            box.index.setValue(1)
            box.label.setValue("R")
        })
        StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(left.audioEffects))
        boxGraph.endTransaction()
        const bytes = PresetEncoder.encodeEffects([split], PresetHeader.ChainKind.Audio) as ArrayBuffer
        const {boxGraph: targetGraph, targetUnit} = decodeChain(bytes)
        const splits = targetGraph.boxes().filter(box => box instanceof StereoCompositeBox) as StereoCompositeBox[]
        expect(splits.length).toBe(1)
        expect(splits[0].host.targetVertex.unwrap("split.host").address).toStrictEqual(targetUnit.audioEffects.address)
        const entries = (targetGraph.boxes().filter(box => box instanceof AudioEffectCompositeCellBox) as AudioEffectCompositeCellBox[])
            .sort((a, b) => a.index.getValue() - b.index.getValue())
        expect(entries.map(entry => entry.label.getValue())).toStrictEqual(["L", "R"])
        expect(entries.map(entry => entry.index.getValue())).toStrictEqual([0, 1])
        const stereoTool = targetGraph.boxes().find(box => box instanceof StereoToolDeviceBox) as StereoToolDeviceBox
        expect((stereoTool.host.targetVertex.unwrap("stereoTool.host").box as AudioEffectCompositeCellBox)
            .label.getValue(), "the nested effect stays hosted by the L branch").toBe("L")
    })

    it("round-trips a composite NESTED inside another composite's entry", () => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        const outer = AudioEffectCompositeBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        })
        const outerEntry = AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(outer.entries)
            box.index.setValue(0)
            box.label.setValue("outer")
        })
        const inner = AudioEffectCompositeBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(outerEntry.audioEffects)
            box.index.setValue(0)
        })
        const innerEntry = AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(inner.entries)
            box.index.setValue(0)
            box.label.setValue("inner")
        })
        StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(innerEntry.audioEffects))
        boxGraph.endTransaction()
        const bytes = PresetEncoder.encodeEffects([outer], PresetHeader.ChainKind.Audio) as ArrayBuffer
        const {boxGraph: targetGraph, targetUnit} = decodeChain(bytes)
        const composites = targetGraph.boxes().filter(box => box instanceof AudioEffectCompositeBox) as AudioEffectCompositeBox[]
        expect(composites.length).toBe(2)
        const pastedOuter = composites.find(box =>
            box.host.targetVertex.unwrap("host").address.equals(targetUnit.audioEffects.address))!
        expect(pastedOuter, "exactly one composite sits on the unit chain").toBeDefined()
        const pastedOuterEntry = targetGraph.boxes()
            .find(box => box instanceof AudioEffectCompositeCellBox
                && box.label.getValue() === "outer") as AudioEffectCompositeCellBox
        const pastedInner = composites.find(box => box !== pastedOuter)!
        expect(pastedInner.host.targetVertex.unwrap("inner.host").box,
            "the inner composite stays hosted by the outer entry").toBe(pastedOuterEntry)
        const stereoTool = targetGraph.boxes().find(box => box instanceof StereoToolDeviceBox) as StereoToolDeviceBox
        expect((stereoTool.host.targetVertex.unwrap("stereoTool.host").box as AudioEffectCompositeCellBox)
            .label.getValue(), "the deepest effect stays hosted by the inner entry").toBe("inner")
    })
})
