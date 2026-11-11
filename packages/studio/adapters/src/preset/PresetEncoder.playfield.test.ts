import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {
    AudioFileBox,
    CaptureMidiBox,
    InstrumentCompositeCellBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    StereoToolDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {DeviceBoxUtils} from "../DeviceBox"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitFactory} from "../factories/AudioUnitFactory"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"
import {PlayfieldPads} from "../devices/instruments/Playfield/PlayfieldPads"

// #265: Saving a Playfield as an instrument preset dropped effects placed in sample slots.
// The instrument-preset path excludes the audio-unit effect chain, but the predicate excluded
// *every* effect box — including effects nested inside the Playfield's sample slots.
describe("PresetEncoder (Playfield slot effects, #265)", () => {
    const buildPlayfieldPreset = (legacySlot: boolean): ArrayBuffer => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        const playfield = PlayfieldDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.startInSeconds.setValue(0); box.endInSeconds.setValue(1); box.fileName.setValue("kick.wav")
        })
        const audioEffects = legacySlot
            ? PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
                box.device.refer(playfield.samples); box.file.refer(file); box.index.setValue(0)
            }).audioEffects
            : PlayfieldPads.create(boxGraph, playfield, file, 0).audioEffects
        StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(audioEffects))
        StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.audioEffects))
        boxGraph.endTransaction()
        return PresetEncoder.encode(unit, {
            excludeEffect: box => DeviceBoxUtils.isChainEffectOf(box, unit)
        }) as ArrayBuffer
    }

    const decodePadEffectHost = (presetBytes: ArrayBuffer) => {
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        target.boxGraph.beginTransaction()
        PresetDecoder.decode(presetBytes, target)
        target.boxGraph.endTransaction()
        const effects = target.boxGraph.boxes().filter(box => box instanceof StereoToolDeviceBox)
        expect(effects.length).toBe(1)
        expect(target.boxGraph.boxes().some(box => box instanceof PlayfieldSampleBox)).toBe(false)
        expect(target.boxGraph.boxes().filter(box => box instanceof NanoDeviceBox)).toHaveLength(1)
        return effects[0].host.targetVertex.unwrap().box
    }

    it("preserves effects in Playfield pads while dropping the audio-unit chain", () => {
        expect(decodePadEffectHost(buildPlayfieldPreset(false))).toBeInstanceOf(InstrumentCompositeCellBox)
    })

    it("migrates a preset saved with slots to pads and keeps the slot effects", () => {
        expect(decodePadEffectHost(buildPlayfieldPreset(true))).toBeInstanceOf(InstrumentCompositeCellBox)
    })
})
