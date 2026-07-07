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
})
