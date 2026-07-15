import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {
    AnyLoopableRegionBoxAdapter,
    AnyRegionBoxAdapter,
    ProjectSkeleton,
    TrackBoxAdapter,
    TrackType
} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {RegionModifyStrategies, RegionModifyStrategy} from "./RegionModifyStrategies"
import type {ProjectEnv} from "../../project/ProjectEnv"

// Empirical sweep for live error 1054 ("regions overlap: prev.complete(5760) > next.position(4320)"). The clip
// overlap resolver (default behaviour) should trim existing regions out of a moved region's footprint, then
// validateTrack asserts no residual overlap. Static reading of createTasksFromMasks says the simple two-region
// case is handled, so this brute-forces layouts + move deltas in clip mode to find the geometry that still
// throws after resolution.

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

const makeMoveStrategy = (deltaPosition: ppqn): RegionModifyStrategies => ({
    showOrigin: () => false,
    selectedModifyStrategy: (): RegionModifyStrategy => ({
        translateTrackIndex: (index) => index,
        readPosition: (region) => region.position + deltaPosition,
        readComplete: (region) => region.resolveComplete(region.position + deltaPosition),
        readMirror: (region) => region.canMirror && region.isMirrowed,
        readLoopOffset: (region) => (region as AnyLoopableRegionBoxAdapter).loopOffset,
        readLoopDuration: (region) => (region as AnyLoopableRegionBoxAdapter).resolveLoopDuration(region.position + deltaPosition),
        iterateRange: (regions, from, to) => regions.iterateRange(from - deltaPosition, to - deltaPosition)
    }),
    unselectedModifyStrategy: () => RegionModifyStrategy.Identity
})

type Span = { position: number, duration: number }

const buildProject = async (layout: ReadonlyArray<Span>) => {
    const {Project} = await import("../../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    layout.forEach(({position, duration}) => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopDuration.setValue(duration)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        })
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter}
}

const runMove = async (layout: ReadonlyArray<Span>, moveIndex: number, delta: ppqn): Promise<Option<string>> => {
    const {project, trackAdapter} = await buildProject(layout)
    const regions: ReadonlyArray<AnyRegionBoxAdapter> = trackAdapter.regions.collection.asArray()
    const moved = regions[moveIndex]
    if (!isDefined(moved)) {project.terminate(); return Option.None}
    moved.onSelected()
    const attempt = tryCatch(() =>
        project.overlapResolver.apply([trackAdapter], [moved], makeMoveStrategy(delta), 0, () => {
            moved.position += delta
        }))
    project.terminate()
    return attempt.status === "failure"
        ? Option.wrap(String((attempt.error as Error)?.message ?? attempt.error))
        : Option.None
}

// RESULT: single-region moves in clip mode do NOT reproduce 1054. For every region validateTrack actually
// checks (note or musical audio; seconds-based audio is allowOverlap-exempt) duration is position-independent,
// so `complete === resolveComplete` and the resolver's trim target matches the validation. The reporter's throw
// therefore needs a dimension this sweep does not cover (multi-op/undo history, or a state these builders can't
// construct). Kept as a green regression guard for the single-move invariant; extend the layouts/selection when
// the reporter's project narrows the geometry.
describe("clip overlap resolver never leaves a residual overlap on a single-region move (1054 sweep)", () => {
    it("sweeps region layouts + move deltas and asserts no residual overlap", async () => {
        // Every layout is non-overlapping (the box graph prunes overlapping regions at creation); the overlap
        // only ever arises transiently from the move, which the clip resolver is meant to absorb.
        const layouts: ReadonlyArray<ReadonlyArray<Span>> = [
            [{position: 2880, duration: 2880}, {position: 5760, duration: 2880}],
            [{position: 0, duration: 1440}, {position: 1440, duration: 1440}],
            [{position: 0, duration: 1440}, {position: 2880, duration: 1440}],
            [{position: 0, duration: 960}, {position: 960, duration: 960}, {position: 1920, duration: 960}],
            [{position: 0, duration: 480}, {position: 480, duration: 2880}, {position: 3360, duration: 480}],
            [{position: 1440, duration: 2880}, {position: 4320, duration: 480}, {position: 4800, duration: 2880}],
            [{position: 0, duration: 1440}, {position: 2880, duration: 1440}, {position: 5760, duration: 1440}]
        ]
        const deltas: ReadonlyArray<ppqn> = [-3840, -2880, -1920, -1440, -960, -480, 480, 960, 1440, 1920, 2880, 3840]
        const failures: Array<string> = []
        for (let layoutIndex = 0; layoutIndex < layouts.length; layoutIndex++) {
            const layout = layouts[layoutIndex]
            for (let moveIndex = 0; moveIndex < layout.length; moveIndex++) {
                for (const delta of deltas) {
                    const result = await runMove(layout, moveIndex, delta)
                    result.ifSome(message => failures.push(
                        `layout#${layoutIndex} move region[${moveIndex}] by ${delta}: ${message}`))
                }
            }
        }
        expect(failures, failures.join("\n")).toEqual([])
    })
})
