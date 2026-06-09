import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {IndexedBox} from "@opendaw/lib-box"
import {
    AudioBusBox,
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    CaptureAudioBox,
    RootBox,
    TapeDeviceBox,
    TrackBox,
    ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {TrackType} from "../timeline/TrackType"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"

// Repro for the "Mixer has no channel-strip state for audio-unit … (type=output, attached=true) …
// absent from rootBox.audioUnits" panic (#924/925/926/984/985 and #1005/1006/1007).
//
// Replacing an audio unit with a preset goes through PresetDecoder.replaceAudioUnit. Unlike the
// sibling transfer paths (PresetDecoder.decode, PresetEncoder.encodeEffects) it does NOT call
// TransferUtils.shouldExclude and does NOT exclude AudioUnitBox/RootBox/AudioBusBox, nor does it use
// TransferUtils.generateMap to remap the AudioUnits/AudioOutput pointers onto the project's own
// rootBox.audioUnits / primary bus. Its dependency closure (alwaysFollowMandatory) therefore follows
// the source unit's mandatory collection→RootBox and output→AudioBusBox pointers and grafts the
// preset's own RootBox/AudioBus/Output unit into the target project graph. That contamination is what
// leaves the project's Output unit unreachable from the rootBox.audioUnits the Mixer subscribes to.
describe("PresetDecoder.replaceAudioUnit", () => {
    const createInstrumentUnit = (target: ProjectSkeleton): AudioUnitBox => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        let unit!: AudioUnitBox
        boxGraph.beginTransaction()
        unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        unit.capture.refer(capture)
        TapeDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Instrument")
            box.host.refer(unit.input)
        })
        boxGraph.endTransaction()
        return unit
    }

    // A sampler-style unit with a timeline track + audio region + audio file, mirroring the Playfield
    // preset in the report (AudioFileBox:11, AudioUnitBox:2). encode() with includeTimeline carries it all.
    const addAudioTrackWithRegion = (target: ProjectSkeleton, unit: AudioUnitBox): void => {
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const track = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(unit.tracks)
            box.target.refer(unit)
            box.index.setValue(0)
        })
        const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(2.0)
            box.fileName.setValue("sample.wav")
        })
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.file.refer(file)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(1000)
        })
        boxGraph.endTransaction()
    }

    const integrity = (boxGraph: ProjectSkeleton["boxGraph"], rootBox: ProjectSkeleton["mandatoryBoxes"]["rootBox"],
                       outputUnit: AudioUnitBox): void => {
        const enrolled = IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
        const count = (ctor: Function) => boxGraph.boxes().filter(box => box instanceof ctor).length
        expect(count(RootBox)).toBe(1)
        expect(count(AudioBusBox)).toBe(1)
        expect(outputUnit.isAttached()).toBe(true)
        // The Mixer builds its channel-strip #states from exactly this collection; the (attached) Output
        // unit must remain enrolled or registerChannelStrip panics "absent from rootBox.audioUnits".
        expect(enrolled).toContain(outputUnit)
    }

    it("sampler preset with timeline replaced twice (mirrors #1005 sequence)", () => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const sourceUnit = createInstrumentUnit(source)
        addAudioTrackWithRegion(source, sourceUnit)
        const presetBuffer = PresetEncoder.encode(sourceUnit, {includeTimeline: true}) as ArrayBuffer

        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioUnitBox: outputUnit}} = target

        const unitA = createInstrumentUnit(target)
        boxGraph.beginTransaction()
        const resultA = PresetDecoder.replaceAudioUnit(presetBuffer, unitA)
        boxGraph.endTransaction()
        expect(resultA.isSuccess(), resultA.isFailure() ? String(resultA.failureReason()) : "ok").toBe(true)
        integrity(boxGraph, rootBox, outputUnit)

        const unitB = createInstrumentUnit(target)
        boxGraph.beginTransaction()
        const resultB = PresetDecoder.replaceAudioUnit(presetBuffer, unitB)
        boxGraph.endTransaction()
        expect(resultB.isSuccess(), resultB.isFailure() ? String(resultB.failureReason()) : "ok").toBe(true)
        integrity(boxGraph, rootBox, outputUnit)
    })

    it("keeps the Output unit enrolled in rootBox.audioUnits and grafts no preset RootBox/bus/unit", () => {
        // A preset exactly as PresetEncoder produces it: a full skeleton carrying its own RootBox +
        // primary AudioBus + Output AudioUnit alongside the instrument unit.
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const presetBuffer = PresetEncoder.encode(createInstrumentUnit(source)) as ArrayBuffer

        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioUnitBox: outputUnit}} = target
        const targetUnit = createInstrumentUnit(target)

        const enrolledUnits = () => IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
        const count = (ctor: Function) => boxGraph.boxes().filter(box => box instanceof ctor).length

        expect(outputUnit.type.getValue()).toBe(AudioUnitType.Output)
        expect(enrolledUnits()).toContain(outputUnit)
        expect(count(RootBox)).toBe(1)
        expect(count(AudioUnitBox)).toBe(2) // output + targetUnit

        boxGraph.beginTransaction()
        const result = PresetDecoder.replaceAudioUnit(presetBuffer, targetUnit)
        boxGraph.endTransaction()
        expect(result.isSuccess(), result.isFailure() ? String(result.failureReason()) : "ok").toBe(true)

        // The replace must reuse the existing units, not inject the preset's singletons.
        expect(count(RootBox)).toBe(1)
        expect(count(AudioBusBox)).toBe(1)
        expect(count(AudioUnitBox)).toBe(2)
        // The Mixer builds its channel-strip #states from exactly this collection; the (attached)
        // Output unit must remain enrolled or registerChannelStrip panics "absent from rootBox.audioUnits".
        expect(outputUnit.isAttached()).toBe(true)
        expect(enrolledUnits()).toContain(outputUnit)
    })
})
