import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "@opendaw/studio-core"
import {RegionDuplication} from "@/ui/timeline/tracks/audio-unit/regions/RegionDuplication.ts"

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

type Behaviour = "clip" | "push-existing" | "keep-existing"
type Layout = ReadonlyArray<readonly [number, number]>

const setBehaviour = async (value: Behaviour) => {
    const {StudioPreferences} = await import("@opendaw/studio-core")
    StudioPreferences.settings.editing["overlapping-regions-behaviour"] = value
}

// one note track per layout, each region as [position, duration]
const buildProject = async (...layouts: ReadonlyArray<Layout>) => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBoxes = layouts.map((layout, index) => {
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.index.setValue(index)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        layout.forEach(([position, duration]) => {
            const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
            NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopDuration.setValue(duration)
                box.regions.refer(trackBox.regions)
                box.events.refer(events.owners)
            })
        })
        return trackBox
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const tracks = trackBoxes.map(trackBox => project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter))
    // every track of the unit in index order, including the ones an overlap behaviour created
    const allSpans = () => primaryAudioUnitBox.tracks.pointerHub.incoming()
        .map(({box}) => project.boxAdapters.adapterFor(box, TrackBoxAdapter))
        .toSorted((left, right) => left.indexField.getValue() - right.indexField.getValue())
        .map(spans)
    return {project, tracks, allSpans}
}

const spans = (track: TrackBoxAdapter) =>
    track.regions.collection.asArray().map(region => [region.position, region.duration])

afterEach(() => setBehaviour("clip"))

describe("RegionDuplication.duplicateSelected", () => {
    it("copies immediately after the source, selects the copy and repeats on that copy", async () => {
        const {project, tracks: [track]} = await buildProject([[100, 960]])
        const source = track.regions.collection.asArray()[0]
        project.regionSelection.select(source)
        expect(RegionDuplication.duplicateSelected(project)).toBe(true)
        const regions = track.regions.collection.asArray()
        expect(regions.map(region => region.position)).toEqual([100, 1060])
        expect(project.regionSelection.selected()).toEqual([regions[1]])
        expect(regions[1].trackBoxAdapter.unwrap()).toBe(track)
        expect(project.trackFocus.track.unwrap()).toBe(track)
        RegionDuplication.duplicateSelected(project)
        expect(track.regions.collection.asArray().map(region => region.position)).toEqual([100, 1060, 2020])
        expect(project.editing.undo()).toBe(true)
        expect(track.regions.collection.asArray().map(region => region.position)).toEqual([100, 1060])
        expect(project.editing.redo()).toBe(true)
        expect(track.regions.collection.asArray().map(region => region.position)).toEqual([100, 1060, 2020])
        project.terminate()
    })
    it("duplicates adjacent clips as a block without changing the sources", async () => {
        const {project, tracks: [track]} = await buildProject([[0, 960], [960, 960]])
        project.regionSelection.select(...track.regions.collection.asArray())
        RegionDuplication.duplicateSelected(project)
        expect(spans(track)).toEqual([[0, 960], [960, 960], [1920, 960], [2880, 960]])
        expect(project.regionSelection.count()).toBe(2)
        project.terminate()
    })
    it("does nothing and reports it without a selected region", async () => {
        const {project, tracks: [track]} = await buildProject([[0, 960]])
        expect(RegionDuplication.duplicateSelected(project)).toBe(false)
        expect(track.regions.collection.asArray()).toHaveLength(1)
        expect(project.editing.undo()).toBe(false)
        project.terminate()
    })
    it("keeps the spacing and the tracks of a selection over two tracks, one undo step", async () => {
        const {project, tracks: [upper, lower], allSpans} = await buildProject([[0, 960]], [[1920, 960]])
        project.regionSelection.select(...upper.regions.collection.asArray(), ...lower.regions.collection.asArray())
        RegionDuplication.duplicateSelected(project)
        expect(allSpans()).toEqual([[[0, 960], [2880, 960]], [[1920, 960], [4800, 960]]])
        expect(project.regionSelection.count()).toBe(2)
        expect(project.editing.undo()).toBe(true)
        expect(allSpans()).toEqual([[[0, 960]], [[1920, 960]]])
        project.terminate()
    })
    it("leaves an unselected region inside the selected span untouched", async () => {
        const {project, tracks: [track]} = await buildProject([[0, 960], [960, 960], [1920, 960]])
        const [first, , third] = track.regions.collection.asArray()
        project.regionSelection.select(first, third)
        RegionDuplication.duplicateSelected(project)
        expect(spans(track)).toEqual([[0, 960], [960, 960], [1920, 960], [2880, 960], [4800, 960]])
        project.terminate()
    })
    // A and B are selected, X sits where the copy of A lands, the copy of B lands on free space
    const Occupied: Layout = [[0, 960], [960, 960], [1920, 960]]
    const duplicateOccupied = async (behaviour: Behaviour) => {
        await setBehaviour(behaviour)
        const built = await buildProject(Occupied)
        const [first, second] = built.tracks[0].regions.collection.asArray()
        built.project.regionSelection.select(first, second)
        RegionDuplication.duplicateSelected(built.project)
        return built
    }
    it("clip: the copies replace what they cover", async () => {
        const {project, allSpans} = await duplicateOccupied("clip")
        expect(allSpans()).toEqual([[[0, 960], [960, 960], [1920, 960], [2880, 960]]])
        expect(project.regionSelection.count()).toBe(2)
        project.terminate()
    })
    it("push-existing: the covered region moves to the track below, the block stays", async () => {
        const {project, allSpans} = await duplicateOccupied("push-existing")
        expect(allSpans()).toEqual([[[0, 960], [960, 960], [1920, 960], [2880, 960]], [[1920, 960]]])
        expect(project.regionSelection.count()).toBe(2)
        project.terminate()
    })
    it("keep-existing: the whole block moves to the track below, not only the colliding copy", async () => {
        const {project, tracks: [track], allSpans} = await duplicateOccupied("keep-existing")
        expect(allSpans()).toEqual([Occupied, [[1920, 960], [2880, 960]]])
        const selected = project.regionSelection.selected()
        expect(selected).toHaveLength(2)
        expect(selected.every(region => region.trackBoxAdapter.unwrap() !== track)).toBe(true)
        expect(selected[0].trackBoxAdapter.unwrap()).toBe(selected[1].trackBoxAdapter.unwrap())
        expect(project.editing.undo()).toBe(true)
        expect(allSpans()).toEqual([Occupied])
        project.terminate()
    })
    it("keep-existing: a free destination keeps the copies on their track", async () => {
        await setBehaviour("keep-existing")
        const {project, tracks: [track], allSpans} = await buildProject([[0, 960], [960, 960]])
        project.regionSelection.select(...track.regions.collection.asArray())
        RegionDuplication.duplicateSelected(project)
        expect(allSpans()).toEqual([[[0, 960], [960, 960], [1920, 960], [2880, 960]]])
        project.terminate()
    })
    it("keep-existing: the block reuses a track below only if every copy fits there", async () => {
        await setBehaviour("keep-existing")
        const {project, tracks: [upper], allSpans} = await buildProject(Occupied, [[2880, 960]])
        const [first, second] = upper.regions.collection.asArray()
        project.regionSelection.select(first, second)
        RegionDuplication.duplicateSelected(project)
        expect(allSpans()).toEqual([Occupied, [[1920, 960], [2880, 960]], [[2880, 960]]])
        project.terminate()
    })
})
