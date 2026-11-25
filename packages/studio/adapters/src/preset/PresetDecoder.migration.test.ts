import {describe, expect, it} from "vitest"
import {Option, UUID, ValueMapping} from "@opendaw/lib-std"
import {
    ArpeggioDeviceBox,
    AudioUnitBox,
    CaptureMidiBox,
    DelayDeviceBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitFactory} from "../factories/AudioUnitFactory"
import {TrackType} from "../timeline/TrackType"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"
import {PresetHeader} from "./PresetHeader"

// A preset saved before the Arpeggio had 18 modes (version 0) must enter a project migrated, otherwise the
// next project load would migrate automation that was already drawn in the new units.
const buildLegacyPreset = (): ArrayBuffer => {
    const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
    const {boxGraph} = source
    boxGraph.beginTransaction()
    const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
    const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
    VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
    const arp = ArpeggioDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(unit.midiEffects)
        box.index.setValue(0)
        box.modeIndex.setValue(1)
        box.version.setValue(0)
    })
    DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.delayMusical.setValue(9)
        box.version.setValue(0)
    })
    const track = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.tracks.refer(unit.tracks)
        box.target.refer(arp.modeIndex)
        box.index.setValue(0)
    })
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    ValueRegionBox.create(boxGraph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.duration.setValue(3840)
    })
    ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.events.refer(events.events)
        box.value.setValue(1.0)
    })
    boxGraph.endTransaction()
    return PresetEncoder.encode(unit, {includeTimeline: true}) as ArrayBuffer
}

const decodeInto = (bytes: ArrayBuffer) => {
    const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
    target.boxGraph.beginTransaction()
    PresetDecoder.decode(bytes, target)
    target.boxGraph.endTransaction()
    return target
}

describe("PresetDecoder migrates versioned devices", () => {
    it("decode: a legacy arp arrives at version 1 with its automation remapped", () => {
        const {boxGraph} = decodeInto(buildLegacyPreset())
        const arp = boxGraph.boxes().find((box): box is ArpeggioDeviceBox => box instanceof ArpeggioDeviceBox)!
        expect(arp.version.getValue()).toBe(1)
        expect(arp.modeIndex.getValue()).toBe(1)
        const event = boxGraph.boxes().find((box): box is ValueEventBox => box instanceof ValueEventBox)!
        expect(ValueMapping.linearInteger(0, 17).y(event.value.getValue())).toBe(2)
    })
    it("decode: a legacy delay arrives at version 1", () => {
        const {boxGraph} = decodeInto(buildLegacyPreset())
        const delay = boxGraph.boxes().find((box): box is DelayDeviceBox => box instanceof DelayDeviceBox)!
        expect(delay.version.getValue()).toBe(1)
        expect(delay.delayMusical.getValue()).toBe(8)
    })
    it("insertEffectChain: a legacy arp chain arrives at version 1", () => {
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
        const unit: AudioUnitBox = AudioUnitFactory.create(target, AudioUnitType.Instrument, Option.wrap(capture))
        const result = PresetDecoder.insertEffectChain(buildLegacyPreset(), unit.midiEffects, 0, PresetHeader.ChainKind.Midi)
        boxGraph.endTransaction()
        expect(result.isSuccess()).toBe(true)
        const arp = boxGraph.boxes().find((box): box is ArpeggioDeviceBox => box instanceof ArpeggioDeviceBox)!
        expect(arp.version.getValue()).toBe(1)
        expect(arp.modeIndex.getValue()).toBe(1)
    })
})
