import {describe, expect, it} from "vitest"
import {int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    NoteRegionBoxAdapter,
    ProjectSkeleton,
    RegionEditing,
    TrackBoxAdapter,
    TrackType
} from "@opendaw/studio-adapters"
import {
    AudioFileBox,
    AudioRegionBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {LoopableRegion, ppqn, PPQN, TimeBase} from "@opendaw/lib-dsp"
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

    it("deletes instead of leaving a sub-ulp sliver when a START task's end ceils within float drift of a seconds-based complete", async () => {
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
        // Same drifted region as above (complete = 2103.0001068…), but the mask covers the region's START, so
        // createTasksFromMasks emits a plain "start" task (not "separate") and #executeTasks calls #trimStart
        // with the ceiled end 2103. Without the tolerance in #trimStart the region survives as [2103, 2103.0001].
        AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(TimeBase.Seconds)
            box.position.setValue(100)
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
        expect(trackAdapter.regions.collection.asArray()[0].complete).toBeGreaterThan(2103)
        const exec = RegionClipResolver.fromRange(trackAdapter, 50, 2102.5)
        boxGraph.beginTransaction()
        exec()
        boxGraph.endTransaction()
        expect(trackAdapter.regions.collection.asArray()).toHaveLength(0)
        project.terminate()
    })
})

describe("RegionClipResolver producer: looped 3/4 note and automation regions keep whole-tick loop offsets", () => {
    // A one-bar 3/4 loop (2880 ppqn) with a note on every beat. 3840 is bar 2, beat 2, and lib-std mod
    // returns 959.9999999999998 for mod(3840, 2880), which the Int32 loopOffset field truncates to 959.
    const beat = PPQN.Quarter
    const bar = 3 * beat

    const createNoteLoop = async (bars: int) => {
        const {Project} = await import("../../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        for (const position of [0, beat, 2 * beat]) {
            NoteEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.events.refer(events.events)
            })
        }
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(bars * bar)
            box.loopDuration.setValue(bar)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton(createEnv(), skeleton)
        return {project, boxGraph, trackAdapter: project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)}
    }

    const noteRegionsOf = (trackAdapter: TrackBoxAdapter): ReadonlyArray<NoteRegionBoxAdapter> =>
        trackAdapter.regions.collection.asArray()
            .filter((region): region is NoteRegionBoxAdapter => region.isNoteRegion())

    // Each loop cycle plays the note at content position p at rawStart + p, if that lies in [resultStart, resultEnd).
    const playedNotes = (region: NoteRegionBoxAdapter): ReadonlyArray<ppqn> => {
        const notes = region.optCollection.unwrap("collection").events.asArray()
        return Array.from(LoopableRegion.locateLoops(region, region.position, region.complete))
            .flatMap(({rawStart, resultStart, resultEnd}) => notes
                .map(note => rawStart + note.position)
                .filter(position => resultStart <= position && position < resultEnd))
    }

    const everyBeat = (from: ppqn, to: ppqn): ReadonlyArray<ppqn> => {
        const beats: Array<ppqn> = []
        for (let position = from; position < to; position += beat) {beats.push(position)}
        return beats
    }

    it("start-trims a loop to loopOffset 960 when a range covers its first bar and a beat", async () => {
        const {project, boxGraph, trackAdapter} = await createNoteLoop(4)
        const exec = RegionClipResolver.fromRange(trackAdapter, 0, 4 * beat)
        boxGraph.beginTransaction()
        exec()
        boxGraph.endTransaction()
        const [region] = noteRegionsOf(trackAdapter)
        expect(region.position).toBe(4 * beat)
        expect(region.loopOffset).toBe(beat) // main: 959
        expect(playedNotes(region)).toEqual(everyBeat(4 * beat, 4 * bar))
        project.terminate()
    })

    it("clips a loop so its right part keeps loopOffset 960 (RegionEditing.clip)", async () => {
        const {project, boxGraph, trackAdapter} = await createNoteLoop(4)
        const exec = RegionClipResolver.fromRange(trackAdapter, bar, 4 * beat)
        boxGraph.beginTransaction()
        exec()
        boxGraph.endTransaction()
        const [left, right] = noteRegionsOf(trackAdapter)
        expect(left.complete).toBe(bar)
        expect(right.position).toBe(4 * beat)
        expect(right.loopOffset).toBe(beat) // main: 959
        expect(playedNotes(right)).toEqual(everyBeat(4 * beat, 4 * bar))
        project.terminate()
    })

    it("cuts a loop at bar 2, beat 2 without moving the right half's notes off their beats", async () => {
        const {project, boxGraph, trackAdapter} = await createNoteLoop(4)
        const [region] = noteRegionsOf(trackAdapter)
        boxGraph.beginTransaction()
        const right = RegionEditing.cut(region, 4 * beat, false).unwrap("right half")
        boxGraph.endTransaction()
        expect(right.loopOffset).toBe(beat) // main: 959
        expect(playedNotes(region)).toEqual(everyBeat(0, 4 * beat))
        expect(playedNotes(right)).toEqual(everyBeat(4 * beat, 4 * bar)) // main: 3841, 4801, 5761, ...
        project.terminate()
    })

    it("does not accumulate drift when the right-hand piece is cut again every four beats", async () => {
        const {project, boxGraph, trackAdapter} = await createNoteLoop(9)
        let [piece] = noteRegionsOf(trackAdapter)
        for (let index = 1; index <= 6; index++) {
            boxGraph.beginTransaction()
            piece = RegionEditing.cut(piece, index * 4 * beat, false).unwrap("right-hand piece")
            boxGraph.endTransaction()
        }
        expect(piece.position).toBe(24 * beat)
        expect(piece.loopOffset).toBe(0) // main stores 959, 1919, 2879, 958, 1918, 2877 along the way
        expect(playedNotes(piece)[0]).toBe(24 * beat) // main: 23043
        expect(noteRegionsOf(trackAdapter).flatMap(playedNotes)).toEqual(everyBeat(0, 9 * bar))
        project.terminate()
    })

    it("cuts a looped automation region at bar 2, beat 2 to loopOffset 960", async () => {
        const {Project} = await import("../../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox.volume)
        })
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(4 * bar)
            box.loopDuration.setValue(bar)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
        const [region] = trackAdapter.regions.collection.asArray()
        expect(region.isValueRegion()).toBe(true)
        boxGraph.beginTransaction()
        const right = RegionEditing.cut(region, 4 * beat, false).unwrap("right half")
        boxGraph.endTransaction()
        expect(right.position).toBe(4 * beat)
        expect(right.loopOffset).toBe(beat) // main: 959
        project.terminate()
    })
})
