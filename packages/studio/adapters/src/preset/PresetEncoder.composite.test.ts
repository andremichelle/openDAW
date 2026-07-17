import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {
    CaptureAudioBox,
    CrusherDeviceBox,
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
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
})
