import {describe, expect, it} from "vitest"
import {int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {LoopableRegion, ppqn, PPQN} from "@opendaw/lib-dsp"
import {NoteRegionBoxAdapter, ProjectSkeleton, RegionEditing, TrackType} from "@opendaw/studio-adapters"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {Project} from "./Project"
import type {ProjectEnv} from "./ProjectEnv"

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

type Note = { position: ppqn, duration: ppqn, pitch: int }
type Loop = { position: ppqn, duration: ppqn, loopOffset: ppqn, loopDuration: ppqn }

const {Bar, Quarter} = PPQN

// Kick on 1, snare on 3, hat on 4. All short, so nothing crosses the bar line.
const Beat: ReadonlyArray<Note> = [
    {position: 0, duration: 240, pitch: 36},
    {position: 2 * Quarter, duration: 240, pitch: 38},
    {position: 3 * Quarter, duration: 240, pitch: 42}
]

// One note region per loop, each on its own note track unless shareTrack, each with its own (unshared) copy of the notes.
const buildProject = async (loops: ReadonlyArray<Loop>, notes: ReadonlyArray<Note>, shareTrack: boolean = false) => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const createTrack = (index: int) => TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.index.setValue(index)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const sharedTrack = shareTrack ? createTrack(0) : null
    const regionBoxes = loops.map(({position, duration, loopOffset, loopDuration}, index) => {
        const trackBox = sharedTrack ?? createTrack(index)
        const collectionBox = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        notes.forEach(note => NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(note.position)
            box.duration.setValue(note.duration)
            box.pitch.setValue(note.pitch)
            box.events.refer(collectionBox.events)
        }))
        return NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopOffset.setValue(loopOffset)
            box.loopDuration.setValue(loopDuration)
            box.regions.refer(trackBox.regions)
            box.events.refer(collectionBox.owners)
        })
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const regions = regionBoxes.map(box => project.boxAdapters.adapterFor(box, NoteRegionBoxAdapter))
    return {project, regions}
}

const eventsOf = (region: NoteRegionBoxAdapter) => region.optCollection.unwrap("collection").events.asArray()

// What the region stores, in region-local positions.
const stored = (region: NoteRegionBoxAdapter): ReadonlyArray<string> =>
    eventsOf(region).map(({position, pitch, duration}) => `${position}:${pitch}:${duration}`)

// What the region plays, in timeline positions: every note that starts inside a loop pass, once per pass.
const played = (region: NoteRegionBoxAdapter): ReadonlyArray<string> => {
    const collection = region.optCollection.unwrap("collection")
    return Array.from(LoopableRegion.locateLoops(region, region.position, region.complete))
        .flatMap(({rawStart, resultStart, resultEnd}) =>
            Array.from(collection.events.iterateRange(resultStart - rawStart, resultEnd - rawStart))
                .map(({position, pitch, duration}) => `${rawStart + position}:${pitch}:${duration}`))
        .toSorted()
}

const noteIds = (region: NoteRegionBoxAdapter): ReadonlyArray<string> =>
    eventsOf(region).map(event => UUID.toString(event.uuid))

// flatten only takes selected regions, and in the app the timeline sets that flag
const flatten = (project: Project, target: NoteRegionBoxAdapter, regions: ReadonlyArray<NoteRegionBoxAdapter>) => {
    regions.forEach(region => {if (!region.isSelected) {region.onSelected()}})
    return project.editing.modify(() => target.flatten(regions)).unwrap("modify").unwrap("flatten")
}

const collectionCount = (project: Project) =>
    project.boxGraph.boxes().filter(box => box instanceof NoteEventCollectionBox).length

describe("NoteRegionBoxAdapter.flatten keeps the region it is called on", () => {
    it("a 1-bar loop played four times becomes four bars of notes in the same region", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: Bar, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const regionId = UUID.toString(region.uuid)
        const before = played(region)
        const box = flatten(project, region, [region])
        expect(box).toBe(region.box)
        expect(UUID.toString(region.uuid)).toBe(regionId)
        expect(project.boxGraph.findBox(region.uuid).nonEmpty()).toBe(true)
        expect([region.position, region.duration, region.loopOffset, region.loopDuration]).toEqual([Bar, 4 * Bar, 0, 4 * Bar])
        expect(eventsOf(region).length).toBe(12)
        expect(played(region)).toEqual(before)
        project.terminate()
    })

    it("notes stored past the loop end are removed, not revealed", async () => {
        const hidden: Note = {position: Bar + Quarter, duration: 240, pitch: 49}
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar}], [...Beat, hidden])
        const before = played(region)
        flatten(project, region, [region])
        expect(eventsOf(region).some(({pitch}) => pitch === 49)).toBe(false)
        expect(eventsOf(region).length).toBe(6)
        expect(played(region)).toEqual(before)
        project.terminate()
    })

    it("a loop offset and partial passes give the same notes as before the region was kept", async () => {
        // 2.5 bars that start one beat into a 1-bar loop: a 3-beat first pass, a full pass, a 3-beat last pass.
        const loop: Loop = {position: 2 * Bar, duration: 2 * Bar + 2 * Quarter, loopOffset: Quarter, loopDuration: Bar}
        const notes: ReadonlyArray<Note> = [
            {position: 0, duration: 240, pitch: 36},
            {position: Quarter, duration: 240, pitch: 38},
            {position: 2 * Quarter + Quarter / 2, duration: 240, pitch: 42},
            {position: 3 * Quarter, duration: 240, pitch: 46},
            {position: -Quarter / 2, duration: 240, pitch: 50},
            {position: Bar + Quarter / 2, duration: 240, pitch: 51}
        ]
        const {project, regions: [region]} = await buildProject([loop], notes)
        const before = played(region)
        flatten(project, region, [region])
        expect(stored(region)).toEqual([
            "0:38:240", "1440:42:240", "1920:46:240",
            "2880:36:240", "3840:38:240", "5280:42:240", "5760:46:240",
            "6720:36:240", "7680:38:240", "9120:42:240"
        ])
        expect([region.position, region.duration, region.loopOffset, region.loopDuration])
            .toEqual([2 * Bar, 2 * Bar + 2 * Quarter, 0, 2 * Bar + 2 * Quarter])
        expect(played(region)).toEqual(before)
        project.terminate()
    })

    it("the replaced collection is removed when the region was its only owner", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const oldCollection = region.optCollection.unwrap("collection").box
        const count = collectionCount(project)
        flatten(project, region, [region])
        expect(oldCollection.isAttached()).toBe(false)
        expect(collectionCount(project)).toBe(count)
        expect(project.boxGraph.boxes().filter(box => box instanceof NoteEventBox).length).toBe(eventsOf(region).length)
        project.terminate()
    })

    it("a mirrored region gets its own notes, so its sibling keeps looping", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const sibling = project.editing.modify(() => RegionEditing.cut(region, 2 * Bar, false))
            .unwrap("modify").unwrap("cut")
        const originalIds = noteIds(region)
        const regionBefore = played(region)
        const siblingBefore = played(sibling)
        expect(region.isMirrowed).toBe(true)
        flatten(project, region, [region])
        expect(project.boxGraph.findBox(region.uuid).nonEmpty()).toBe(true)
        expect(region.isMirrowed).toBe(false)
        expect(sibling.isMirrowed).toBe(false)
        expect(region.loopDuration).toBe(2 * Bar)
        expect(played(region)).toEqual(regionBefore)
        expect([sibling.position, sibling.duration, sibling.loopOffset, sibling.loopDuration])
            .toEqual([2 * Bar, 2 * Bar, 0, Bar])
        expect(noteIds(sibling)).toEqual(originalIds)
        expect(played(sibling)).toEqual(siblingBefore)
        project.terminate()
    })

    it("flattening two regions keeps the one it is called on and deletes the other", async () => {
        const {project, regions: [left, right]} = await buildProject([
            {position: 0, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar},
            {position: 2 * Bar, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar}
        ], Beat, true)
        project.editing.modify(() => right.box.label.setValue("right"))
        const before = [...played(left), ...played(right)].toSorted()
        const box = flatten(project, right, [left, right])
        expect(box).toBe(right.box)
        expect(left.box.isAttached()).toBe(false)
        expect([right.position, right.duration, right.loopOffset, right.loopDuration]).toEqual([0, 4 * Bar, 0, 4 * Bar])
        expect(right.label).toBe("right")
        expect(played(right)).toEqual(before)
        project.terminate()
    })

    it("called on a region outside the flattened ones, it keeps the first of them", async () => {
        const {project, regions: [left, right, other]} = await buildProject([
            {position: 0, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar},
            {position: 2 * Bar, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar},
            {position: 8 * Bar, duration: Bar, loopOffset: 0, loopDuration: Bar}
        ], Beat, true)
        const box = flatten(project, other, [left, right])
        expect(box).toBe(left.box)
        expect(right.box.isAttached()).toBe(false)
        expect(other.box.isAttached()).toBe(true)
        expect([left.position, left.duration]).toEqual([0, 4 * Bar])
        project.terminate()
    })

    it("the region stays open in the note editor and stays selected", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const {timeline} = project.userEditingManager
        timeline.edit(region.box)
        project.selection.select(region.box)
        flatten(project, region, [region])
        expect(timeline.isEditing(region.box)).toBe(true)
        expect(project.selection.isSelected(region.box)).toBe(true)
        expect(eventsOf(region).length).toBe(12)
        project.terminate()
    })

    it("a note crossing the loop line keeps its full length", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar}],
            [{position: 3 * Quarter, duration: 2 * Quarter, pitch: 46}])
        flatten(project, region, [region])
        expect(stored(region)).toEqual(["2880:46:1920", "6720:46:1920"])
        project.terminate()
    })

    it("undo restores the loop and the original notes, redo flattens again", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: Bar, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const before = stored(region)
        const ids = noteIds(region)
        const playedBefore = played(region)
        const oldCollection = region.optCollection.unwrap("collection").box
        flatten(project, region, [region])
        expect(project.editing.undo()).toBe(true)
        expect([region.position, region.duration, region.loopOffset, region.loopDuration]).toEqual([Bar, 4 * Bar, 0, Bar])
        expect(region.optCollection.unwrap("collection").box.address.uuid).toEqual(oldCollection.address.uuid)
        expect(stored(region)).toEqual(before)
        expect(noteIds(region)).toEqual(ids)
        expect(project.editing.redo()).toBe(true)
        expect(eventsOf(region).length).toBe(12)
        expect(played(region)).toEqual(playedBefore)
        project.terminate()
    })
})
