import {describe, expect, it, beforeEach} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    CaptureAudioBox,
    TapeDeviceBox,
    TrackBox,
    TransientMarkerBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TrackType} from "../timeline/TrackType"
import {TransferAudioUnits} from "./TransferAudioUnits"

describe("TransferAudioUnits.transfer", () => {
    let skeleton: ProjectSkeleton

    beforeEach(() => {
        skeleton = ProjectSkeleton.empty({
            createDefaultUser: false,
            createOutputCompressor: false
        })
    })

    const createAudioUnitWithInstrument = (target: ProjectSkeleton): {
        audioUnitBox: AudioUnitBox,
        instrumentBox: TapeDeviceBox,
        captureBox: CaptureAudioBox
    } => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        let audioUnitBox!: AudioUnitBox
        let instrumentBox!: TapeDeviceBox
        let captureBox!: CaptureAudioBox
        boxGraph.beginTransaction()
        audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        captureBox = CaptureAudioBox.create(boxGraph, UUID.generate())
        audioUnitBox.capture.refer(captureBox)
        instrumentBox = TapeDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Test Tape")
            box.host.refer(audioUnitBox.input)
        })
        boxGraph.endTransaction()
        return {audioUnitBox, instrumentBox, captureBox}
    }

    const createAudioRegion = (target: ProjectSkeleton, audioUnitBox: AudioUnitBox): {
        trackBox: TrackBox,
        regionBox: AudioRegionBox,
        audioFileBox: AudioFileBox
    } => {
        const {boxGraph} = target
        let trackBox!: TrackBox
        let regionBox!: AudioRegionBox
        let audioFileBox!: AudioFileBox
        boxGraph.beginTransaction()
        trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
            box.index.setValue(0)
        })
        audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0)
            box.endInSeconds.setValue(10.0)
            box.fileName.setValue("test-audio.wav")
        })
        regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(trackBox.regions)
            box.file.refer(audioFileBox)
            box.position.setValue(0)
            box.duration.setValue(1000)
        })
        boxGraph.endTransaction()
        return {trackBox, regionBox, audioFileBox}
    }

    const addTransientMarkers = (target: ProjectSkeleton, audioFileBox: AudioFileBox, count: number): TransientMarkerBox[] => {
        const {boxGraph} = target
        const markers: TransientMarkerBox[] = []
        boxGraph.beginTransaction()
        for (let index = 0; index < count; index++) {
            markers.push(TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
                box.owner.refer(audioFileBox.transientMarkers)
                box.position.setValue(index * 0.1)
            }))
        }
        boxGraph.endTransaction()
        return markers
    }

    it("creates new AudioUnitBox with new UUID", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        const originalUUID = audioUnitBox.address.uuid
        skeleton.boxGraph.beginTransaction()
        const [copiedAudioUnit] = TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        expect(copiedAudioUnit).toBeDefined()
        expect(UUID.equals(copiedAudioUnit.address.uuid, originalUUID)).toBe(false)
    })

    it("copies instrument with AudioUnitBox", () => {
        const {audioUnitBox, instrumentBox} = createAudioUnitWithInstrument(skeleton)
        const originalInstrumentUUID = instrumentBox.address.uuid
        skeleton.boxGraph.beginTransaction()
        const [copiedAudioUnit] = TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        const copiedInstrument = copiedAudioUnit.input.pointerHub.incoming().at(0)?.box
        expect(copiedInstrument).toBeDefined()
        expect(copiedInstrument).toBeInstanceOf(TapeDeviceBox)
        expect(UUID.equals(copiedInstrument!.address.uuid, originalInstrumentUUID)).toBe(false)
    })

    it("preserves AudioFileBox UUID (shared resource)", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        const {audioFileBox} = createAudioRegion(skeleton, audioUnitBox)
        const originalFileUUID = audioFileBox.address.uuid
        skeleton.boxGraph.beginTransaction()
        const [copiedAudioUnit] = TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        const copiedTrack = copiedAudioUnit.tracks.pointerHub.incoming().at(0)?.box as TrackBox
        const copiedRegion = copiedTrack?.regions.pointerHub.incoming().at(0)?.box as AudioRegionBox
        const copiedFileUUID = copiedRegion?.file.targetAddress.unwrap().uuid
        expect(UUID.equals(copiedFileUUID, originalFileUUID)).toBe(true)
    })

    it("does not duplicate regions when copying twice", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        createAudioRegion(skeleton, audioUnitBox)
        skeleton.boxGraph.beginTransaction()
        const [firstCopy] = TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        const firstCopyTrack = firstCopy.tracks.pointerHub.incoming().at(0)?.box as TrackBox
        const firstCopyRegionCount = firstCopyTrack?.regions.pointerHub.incoming().length ?? 0
        skeleton.boxGraph.beginTransaction()
        const [secondCopy] = TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        const secondCopyTrack = secondCopy.tracks.pointerHub.incoming().at(0)?.box as TrackBox
        const secondCopyRegionCount = secondCopyTrack?.regions.pointerHub.incoming().length ?? 0
        const firstCopyRegionCountAfter = firstCopyTrack?.regions.pointerHub.incoming().length ?? 0
        expect(firstCopyRegionCount).toBe(1)
        expect(secondCopyRegionCount).toBe(1)
        expect(firstCopyRegionCountAfter).toBe(1)
    })

    it("does not include regions from previous copies", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        createAudioRegion(skeleton, audioUnitBox)
        const initialRegionCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length
        skeleton.boxGraph.beginTransaction()
        TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        const afterFirstCopyCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length
        skeleton.boxGraph.beginTransaction()
        TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        const afterSecondCopyCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length
        expect(afterFirstCopyCount).toBe(initialRegionCount + 1)
        expect(afterSecondCopyCount).toBe(initialRegionCount + 2)
    })

    it("skips TransientMarkerBox when AudioFileBox already exists", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        const {audioFileBox} = createAudioRegion(skeleton, audioUnitBox)
        addTransientMarkers(skeleton, audioFileBox, 5)
        const initialMarkerCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof TransientMarkerBox).length
        skeleton.boxGraph.beginTransaction()
        TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        const afterCopyMarkerCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof TransientMarkerBox).length
        expect(initialMarkerCount).toBe(5)
        expect(afterCopyMarkerCount).toBe(5)
    })

    it("handles multiple copies without exponential growth", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        createAudioRegion(skeleton, audioUnitBox)
        const copyCount = 5
        for (let index = 0; index < copyCount; index++) {
            skeleton.boxGraph.beginTransaction()
            TransferAudioUnits.transfer([audioUnitBox], skeleton)
            skeleton.boxGraph.endTransaction()
        }
        const totalRegionCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length
        expect(totalRegionCount).toBe(1 + copyCount)
    })

    it("copies to target graph in cross-project scenario", () => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputCompressor: false})
        const {audioUnitBox} = createAudioUnitWithInstrument(source)
        skeleton.boxGraph.beginTransaction()
        const [copiedAudioUnit] = TransferAudioUnits.transfer([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()
        expect(copiedAudioUnit.graph).toBe(skeleton.boxGraph)
        expect(copiedAudioUnit.graph).not.toBe(source.boxGraph)
    })
})
