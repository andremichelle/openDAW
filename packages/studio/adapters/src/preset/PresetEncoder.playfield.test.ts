import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {
    AudioFileBox,
    CaptureMidiBox,
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

// #265: Saving a Playfield as an instrument preset dropped effects placed in sample slots.
// The instrument-preset path excludes the audio-unit effect chain, but the predicate excluded
// *every* effect box — including effects nested inside the Playfield's sample slots.
describe("PresetEncoder (Playfield slot effects, #265)", () => {
    const buildPlayfieldPreset = (): ArrayBuffer => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        const playfield = PlayfieldDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.startInSeconds.setValue(0); box.endInSeconds.setValue(1); box.fileName.setValue("kick.wav")
        })
        const slot = PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
            box.device.refer(playfield.samples); box.file.refer(file); box.index.setValue(0)
        })
        StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(slot.audioEffects))
        StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.audioEffects))
        boxGraph.endTransaction()
        return PresetEncoder.encode(unit, {
            excludeEffect: box => DeviceBoxUtils.isChainEffectOf(box, unit)
        }) as ArrayBuffer
    }

    it("preserves effects in Playfield sample slots while dropping the audio-unit chain", () => {
        const presetBytes = buildPlayfieldPreset()
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        target.boxGraph.beginTransaction()
        PresetDecoder.decode(presetBytes, target)
        target.boxGraph.endTransaction()
        const effects = target.boxGraph.boxes().filter(box => box instanceof StereoToolDeviceBox)
        expect(effects.length).toBe(1)
        const host = effects[0].host.targetVertex.unwrap().box
        expect(host).toBeInstanceOf(PlayfieldSampleBox)
    })
})
