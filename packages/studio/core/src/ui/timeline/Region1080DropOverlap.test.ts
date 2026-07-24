import {describe, expect, it} from "vitest"
import {asDefined, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {AudioContentFactory} from "../../project/audio/AudioContentFactory"
import type {ProjectEnv} from "../../project/ProjectEnv"

// Live error family 1054/1057/1072/1078/1079/1080 ("regions overlap"). The panics fire on ARBITRARY region
// edits (including no-ops, see 1057), so the invalid track state pre-exists the edit. This test proves one
// silent creator: the sample-drop path (RegionDragAndDrop.handleSample) computes its clip mask from
// `AudioContentFactory.calculateDuration`, which for a bpm-less sample returns the duration in SECONDS as if
// it were ppqn — a near-zero mask — while `createNotStretchedRegion` creates a seconds-timebase region whose
// real extent is tempo-mapped (4 s @ 120 bpm = 7680 ppqn). The resolver therefore trims nothing underneath
// the dropped region, and validateTrack's seconds-exemption (allowOverlap) hides the stack at drop time.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const SAMPLE_SECONDS = 4.0
const PROJECT_BPM = 120.0

describe("sample drop must clip the regions underneath its real extent (1080)", () => {
    it("drops a bpm-less sample over an existing musical region and leaves no overlap", async () => {
        const {Project} = await import("../../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.fileName.setValue("drop.wav")
            box.endInSeconds.setValue(SAMPLE_SECONDS)
        })
        const existingEvents = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(PPQN.Bar)
            box.loopDuration.setValue(PPQN.Bar)
            box.timeBase.setValue(TimeBase.Musical)
            box.regions.refer(trackBox.regions)
            box.file.refer(audioFileBox)
            box.events.refer(existingEvents.owners)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
        // The drop flow of RegionDragAndDrop.handleSample, verbatim: mask from calculateDuration, then create,
        // then resolve. `bpm: 0` = a plain user file without tempo metadata (`type === "file"` branch).
        const sample = {
            uuid: UUID.toString(UUID.generate()), name: "drop.wav",
            duration: SAMPLE_SECONDS, bpm: 0.0, sample_rate: 48000, origin: "import" as const
        }
        const pointerPulse = 0
        const maskDuration = AudioContentFactory.calculateDuration(sample, project.tempoMap, pointerPulse)
        project.editing.modify(() => {
            const solver = project.overlapResolver.fromRange(
                trackAdapter, pointerPulse, pointerPulse + maskDuration)
            AudioContentFactory.createNotStretchedRegion({
                boxGraph, targetTrack: trackBox, audioFileBox, sample, position: pointerPulse
            })
            solver()
        })
        const regions = trackAdapter.regions.collection.asArray()
        const dropped = asDefined(regions.find(region =>
                region.isAudioRegion() && region.box.timeBase.getValue() === TimeBase.Seconds),
            "the dropped seconds region must exist")
        const expectedExtent = PPQN.secondsToPulses(SAMPLE_SECONDS, PROJECT_BPM)
        expect(dropped.duration).toBe(expectedExtent)
        const overlaps = regions.filter(region => region !== dropped
            && region.position < dropped.complete && region.complete > dropped.position)
        project.terminate()
        expect(overlaps, "the existing musical region must be clipped out of the drop's real extent")
            .toEqual([])
    })
})
