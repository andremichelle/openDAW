import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {IndexedBox} from "@opendaw/lib-box"
import {
    AudioBusBox,
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    CaptureMidiBox,
    RootBox,
    TrackBox,
    ValueEventCollectionBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitFactory} from "../factories/AudioUnitFactory"
import {TrackType} from "../timeline/TrackType"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"

// #1008-1010: the panic's diagnostic shows the output unit's `collection` pointing at a SECOND RootBox
// (collectionEdge=<otherRoot>/20), with identical UUIDs across projects — i.e. an import grafts a preset's
// own RootBox + Output unit. createNewAudioUnitFromRack uses PresetDecoder.decode; this drives exactly that.
describe("PresetDecoder.decode (rack import)", () => {
    const buildPresetBytes = (): ArrayBuffer => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        const track = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio); box.tracks.refer(unit.tracks); box.target.refer(unit); box.index.setValue(0)
        })
        const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.startInSeconds.setValue(0); box.endInSeconds.setValue(2); box.fileName.setValue("s.wav")
        })
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(track.regions); box.file.refer(file); box.events.refer(events.owners)
            box.position.setValue(0); box.duration.setValue(1000)
        })
        boxGraph.endTransaction()
        return PresetEncoder.encode(unit, {includeTimeline: true}) as ArrayBuffer
    }

    it("does not graft the preset's RootBox / Output unit into the project", () => {
        const presetBytes = buildPresetBytes()
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioUnitBox: outputUnit}} = target

        boxGraph.beginTransaction()
        PresetDecoder.decode(presetBytes, target)
        boxGraph.endTransaction()

        const count = (ctor: Function) => boxGraph.boxes().filter(box => box instanceof ctor).length
        const enrolled = IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
        const outputs = boxGraph.boxes().filter((box): box is AudioUnitBox =>
            box instanceof AudioUnitBox && box.type.getValue() === AudioUnitType.Output)

        expect(count(RootBox)).toBe(1)        // <-- the suspected graft
        expect(outputs.length).toBe(1)
        expect(count(AudioBusBox)).toBe(1)
        expect(enrolled).toContain(outputUnit)
        // every audio unit must point its collection at THIS project's root.audioUnits
        const strays = boxGraph.boxes().filter((box): box is AudioUnitBox => box instanceof AudioUnitBox)
            .filter(unit => unit.collection.targetVertex.mapOr(
                vertex => !vertex.address.equals(rootBox.audioUnits.address), true))
        expect(strays.length, "units enrolled in a foreign root").toBe(0)
    })
})
