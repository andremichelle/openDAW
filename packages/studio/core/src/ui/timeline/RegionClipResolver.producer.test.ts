import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {RegionClipResolver} from "./RegionClipResolver"
import type {ProjectEnv} from "../../project/ProjectEnv"

// jsdom lacks the Web Audio worklet globals that EngineWorklet extends at module-eval time.
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

describe("RegionClipResolver producer: fractional boundary quantization (#287)", () => {
    it("start-trims a seconds-based region to an integer position that does not overlap the clip", async () => {
        const {Project} = await import("../../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(1))
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        // Bassdrum [4800, ~5777.48] (seconds), spanning past a clip that ends at the fractional 5773.48.
        const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(TimeBase.Seconds)
            box.position.setValue(4800)
            box.duration.setValue(PPQN.pulsesToSeconds(977.48, 120))
            box.loopDuration.setValue(PPQN.pulsesToSeconds(977.48, 120))
            box.loopOffset.setValue(0)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
        const clipComplete = 4800 + PPQN.secondsToPulses(PPQN.pulsesToSeconds(973.48, 120), 120) // ~5773.48
        const exec = RegionClipResolver.fromRange(trackAdapter, 4800, clipComplete)
        boxGraph.beginTransaction()
        exec()
        boxGraph.endTransaction()
        const position = regionBox.position.getValue()
        expect(Number.isInteger(position)).toBe(true)      // no Int32 truncation desync
        expect(position).toBe(5774)                         // ceil(5773.48): starts clear of the clip
        expect(position).toBeGreaterThanOrEqual(clipComplete) // does not overlap the clip footprint
        project.terminate()
    })

    it("does not leave a sub-ulp sliver when a mask end ceils within float drift of a seconds-based complete", async () => {
        const {Project} = await import("../../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(60))
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        // A seconds-based region whose ppqn complete drifts a float32 ulp ABOVE an integer: 2003 pulses stored
        // as float32 seconds reads back as complete = 2003.0001068… A mask that ends fractionally below 2003
        // ceils (in #executeTasks) to 2003, so the exact compare sent it to RegionEditing.clip and carved a
        // ~1e-4-duration second part [2003, 2003.0001] — a sliver the fold now trims away.
        AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(TimeBase.Seconds)
            box.position.setValue(0)
            box.duration.setValue(PPQN.pulsesToSeconds(2003, 120))
            box.loopDuration.setValue(PPQN.pulsesToSeconds(2003, 120))
            box.loopOffset.setValue(0)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
        expect(trackAdapter.regions.collection.asArray()[0].complete).toBeGreaterThan(2003) // drift is above the integer
        const exec = RegionClipResolver.fromRange(trackAdapter, 100, 2002.5)
        boxGraph.beginTransaction()
        exec()
        boxGraph.endTransaction()
        // On the exact compare this leaves TWO regions: [0, ~100] and the sliver [2003, 2003.0001]. The fold
        // yields the single trimmed region and no sub-ulp remainder.
        const regions = trackAdapter.regions.collection.asArray()
        expect(regions).toHaveLength(1)
        expect(regions[0].duration).toBeGreaterThan(1) // a real region, not a sliver
        expect(() => RegionClipResolver.validateTrack(trackAdapter)).not.toThrow()
        project.terminate()
    })
})
