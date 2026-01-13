import {describe, expect, it, beforeEach} from "vitest"
import {UUID} from "@moises-ai/lib-std"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    CaptureAudioBox,
    TapeDeviceBox,
    TrackBox,
    TransientMarkerBox
} from "@moises-ai/studio-boxes"
import {AudioUnitType} from "@moises-ai/studio-enums"
import {ProjectSkeleton} from "./ProjectSkeleton"
import {ProjectUtils} from "./ProjectUtils"
import {TrackType} from "../timeline/TrackType"

describe("ProjectUtils.extractAudioUnits", () => {
    let skeleton: ProjectSkeleton

    beforeEach(() => {
        skeleton = ProjectSkeleton.empty({
            createDefaultUser: false,
            createOutputCompressor: false
        })
    })

    const createAudioUnitWithInstrument = (skeleton: ProjectSkeleton): {
        audioUnitBox: AudioUnitBox,
        instrumentBox: TapeDeviceBox,
        captureBox: CaptureAudioBox
    } => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBus}} = skeleton

        let audioUnitBox!: AudioUnitBox
        let instrumentBox!: TapeDeviceBox
        let captureBox!: CaptureAudioBox

        boxGraph.beginTransaction()

        audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBus.input)
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

    const createAudioRegion = (
        skeleton: ProjectSkeleton,
        audioUnitBox: AudioUnitBox
    ): {trackBox: TrackBox, regionBox: AudioRegionBox, audioFileBox: AudioFileBox} => {
        const {boxGraph} = skeleton

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

    const addTransientMarkers = (skeleton: ProjectSkeleton, audioFileBox: AudioFileBox, count: number): TransientMarkerBox[] => {
        const {boxGraph} = skeleton
        const markers: TransientMarkerBox[] = []

        boxGraph.beginTransaction()
        for (let i = 0; i < count; i++) {
            markers.push(TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
                box.owner.refer(audioFileBox.transientMarkers)
                box.position.setValue(i * 0.1)
            }))
        }
        boxGraph.endTransaction()

        return markers
    }

    it("should create new AudioUnitBox with new UUID", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        const originalUUID = audioUnitBox.address.uuid

        skeleton.boxGraph.beginTransaction()
        const [copiedAudioUnit] = ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        expect(copiedAudioUnit).toBeDefined()
        expect(UUID.equals(copiedAudioUnit.address.uuid, originalUUID)).toBe(false)
    })

    it("should copy instrument with AudioUnitBox", () => {
        const {audioUnitBox, instrumentBox} = createAudioUnitWithInstrument(skeleton)
        const originalInstrumentUUID = instrumentBox.address.uuid

        skeleton.boxGraph.beginTransaction()
        const [copiedAudioUnit] = ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        // Find the copied instrument
        const copiedInstrument = copiedAudioUnit.input.pointerHub.incoming().at(0)?.box
        expect(copiedInstrument).toBeDefined()
        expect(copiedInstrument).toBeInstanceOf(TapeDeviceBox)
        expect(UUID.equals(copiedInstrument!.address.uuid, originalInstrumentUUID)).toBe(false)
    })

    it("should preserve AudioFileBox UUID (shared resource)", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        const {audioFileBox} = createAudioRegion(skeleton, audioUnitBox)
        const originalFileUUID = audioFileBox.address.uuid

        skeleton.boxGraph.beginTransaction()
        const [copiedAudioUnit] = ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        // Find the copied region's file reference
        const copiedTrack = copiedAudioUnit.tracks.pointerHub.incoming().at(0)?.box as TrackBox
        const copiedRegion = copiedTrack?.regions.pointerHub.incoming().at(0)?.box as AudioRegionBox
        const copiedFileUUID = copiedRegion?.file.targetAddress.unwrap().uuid

        expect(UUID.equals(copiedFileUUID, originalFileUUID)).toBe(true)
    })

    it("should not duplicate regions when copying twice", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        createAudioRegion(skeleton, audioUnitBox)

        // First copy
        skeleton.boxGraph.beginTransaction()
        const [firstCopy] = ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        // Count regions in first copy
        const firstCopyTrack = firstCopy.tracks.pointerHub.incoming().at(0)?.box as TrackBox
        const firstCopyRegionCount = firstCopyTrack?.regions.pointerHub.incoming().length ?? 0

        // Second copy
        skeleton.boxGraph.beginTransaction()
        const [secondCopy] = ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        // Count regions in second copy
        const secondCopyTrack = secondCopy.tracks.pointerHub.incoming().at(0)?.box as TrackBox
        const secondCopyRegionCount = secondCopyTrack?.regions.pointerHub.incoming().length ?? 0

        // Verify first copy still has same number of regions (not modified)
        const firstCopyRegionCountAfter = firstCopyTrack?.regions.pointerHub.incoming().length ?? 0

        expect(firstCopyRegionCount).toBe(1)
        expect(secondCopyRegionCount).toBe(1)
        expect(firstCopyRegionCountAfter).toBe(1)
    })

    it("should not include regions from previous copies", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        createAudioRegion(skeleton, audioUnitBox)

        // Count total AudioRegionBoxes before copies
        const initialRegionCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length

        // First copy
        skeleton.boxGraph.beginTransaction()
        ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        const afterFirstCopyCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length

        // Second copy
        skeleton.boxGraph.beginTransaction()
        ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        const afterSecondCopyCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length

        // Each copy should add exactly 1 region
        expect(afterFirstCopyCount).toBe(initialRegionCount + 1)
        expect(afterSecondCopyCount).toBe(initialRegionCount + 2)
    })

    it("should skip TransientMarkerBox when AudioFileBox already exists", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        const {audioFileBox} = createAudioRegion(skeleton, audioUnitBox)
        addTransientMarkers(skeleton, audioFileBox, 5)

        const initialMarkerCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof TransientMarkerBox).length

        // Copy should not duplicate transient markers
        skeleton.boxGraph.beginTransaction()
        ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
        skeleton.boxGraph.endTransaction()

        const afterCopyMarkerCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof TransientMarkerBox).length

        expect(initialMarkerCount).toBe(5)
        expect(afterCopyMarkerCount).toBe(5) // No new markers created
    })

    it("should handle multiple copies without exponential growth", () => {
        const {audioUnitBox} = createAudioUnitWithInstrument(skeleton)
        createAudioRegion(skeleton, audioUnitBox)

        const copyCount = 5
        for (let i = 0; i < copyCount; i++) {
            skeleton.boxGraph.beginTransaction()
            ProjectUtils.extractAudioUnits([audioUnitBox], skeleton)
            skeleton.boxGraph.endTransaction()
        }

        // Count all AudioRegionBoxes
        const totalRegionCount = skeleton.boxGraph.boxes()
            .filter(box => box instanceof AudioRegionBox).length

        // Should be: 1 original + 5 copies = 6 total
        expect(totalRegionCount).toBe(1 + copyCount)
    })
})
