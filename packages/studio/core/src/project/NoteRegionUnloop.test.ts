import {describe, expect, it} from "vitest"
import {int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {LoopableRegion, ppqn, PPQN} from "@opendaw/lib-dsp"
import {NoteRegionBoxAdapter, ProjectSkeleton, RegionEditing, TrackType} from "@opendaw/studio-adapters"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
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

// One note region per loop, each on its own note track, each with its own (unshared) copy of the notes.
const buildProject = async (loops: ReadonlyArray<Loop>, notes: ReadonlyArray<Note>) => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const regionBoxes = loops.map(({position, duration, loopOffset, loopDuration}, index) => {
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.index.setValue(index)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
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

describe("NoteRegionBoxAdapter.unloop", () => {
    it("a 1-bar loop played four times becomes four bars of notes in the same region", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: Bar, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const regionId = UUID.toString(region.uuid)
        const kickId = UUID.toString(eventsOf(region)[0].uuid)
        const before = played(region)
        expect(region.isMirrowed).toBe(false)
        project.editing.modify(() => region.unloop())
        expect(UUID.toString(region.uuid)).toBe(regionId)
        expect(project.boxGraph.findBox(region.uuid).nonEmpty()).toBe(true)
        expect(region.position).toBe(Bar)
        expect(region.duration).toBe(4 * Bar)
        expect(region.loopOffset).toBe(0)
        expect(region.loopDuration).toBe(4 * Bar)
        expect(eventsOf(region).length).toBe(12)
        expect(played(region)).toEqual(before)
        // the first pass moved the original note boxes instead of copying them
        expect(noteIds(region)[0]).toBe(kickId)
        project.terminate()
    })

    it("notes stored past the loop end are removed, not revealed", async () => {
        const hidden: Note = {position: Bar + Quarter, duration: 240, pitch: 49}
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar}], [...Beat, hidden])
        const before = played(region)
        expect(before.some(note => note.endsWith(":49:240"))).toBe(false)
        project.editing.modify(() => region.unloop())
        expect(eventsOf(region).some(({pitch}) => pitch === 49)).toBe(false)
        expect(eventsOf(region).length).toBe(6)
        expect(played(region)).toEqual(before)
        project.terminate()
    })

    it("a loop with a loop offset and a partial last pass unloops to what flatten produces", async () => {
        // 2.5 bars that start one beat into a 1-bar loop: a 3-beat first pass, a full pass, a 3-beat last pass.
        const loop: Loop = {position: 2 * Bar, duration: 2 * Bar + 2 * Quarter, loopOffset: Quarter, loopDuration: Bar}
        const notes: ReadonlyArray<Note> = [
            {position: 0, duration: 240, pitch: 36}, // skipped by the loop offset in the first pass only
            {position: Quarter, duration: 240, pitch: 38},
            {position: 2 * Quarter + Quarter / 2, duration: 240, pitch: 42},
            {position: 3 * Quarter, duration: 240, pitch: 46}, // cut off by the partial last pass
            {position: -Quarter / 2, duration: 240, pitch: 50}, // negative, never plays
            {position: Bar + Quarter / 2, duration: 240, pitch: 51} // past the loop end, never plays
        ]
        const {project, regions: [region, twin]} = await buildProject([loop, loop], notes)
        const before = played(region)
        project.editing.modify(() => region.unloop())
        // flatten only takes selected regions, and in the app the timeline sets that flag
        twin.onSelected()
        const flattened = project.editing.modify(() => twin.flatten([twin])).unwrap("modify").unwrap("flatten")
        const flat = project.boxAdapters.adapterFor(flattened, NoteRegionBoxAdapter)
        expect(stored(region)).toEqual([
            "0:38:240", "1440:42:240", "1920:46:240",
            "2880:36:240", "3840:38:240", "5280:42:240", "5760:46:240",
            "6720:36:240", "7680:38:240", "9120:42:240"
        ])
        expect(stored(region)).toEqual(stored(flat))
        expect([region.position, region.duration, region.loopOffset, region.loopDuration])
            .toEqual([flat.position, flat.duration, flat.loopOffset, flat.loopDuration])
        expect(played(region)).toEqual(before)
        project.terminate()
    })

    it("a shared region is consolidated first, so its sibling keeps looping", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const sibling = project.editing.modify(() => RegionEditing.cut(region, 2 * Bar, false))
            .unwrap("modify").unwrap("cut")
        const originalIds = noteIds(region)
        const regionBefore = played(region)
        const siblingBefore = played(sibling)
        expect(region.isMirrowed).toBe(true)
        expect(sibling.isMirrowed).toBe(true)
        project.editing.modify(() => region.unloop())
        expect(region.isMirrowed).toBe(false)
        expect(sibling.isMirrowed).toBe(false)
        expect(region.loopDuration).toBe(2 * Bar)
        expect(played(region)).toEqual(regionBefore)
        // the unlooped half works on copies, so none of its note ids are the originals
        expect(noteIds(region).length).toBe(6)
        expect(noteIds(region).some(id => originalIds.includes(id))).toBe(false)
        expect([sibling.position, sibling.duration, sibling.loopOffset, sibling.loopDuration])
            .toEqual([2 * Bar, 2 * Bar, 0, Bar])
        expect(noteIds(sibling)).toEqual(originalIds)
        expect(stored(sibling)).toEqual(Beat.map(({position, pitch, duration}) => `${position}:${pitch}:${duration}`))
        expect(played(sibling)).toEqual(siblingBefore)
        project.terminate()
    })

    it("a shared region drops the notes it never plays without leaving dead entries behind", async () => {
        const hidden: Note = {position: Bar + Quarter, duration: 240, pitch: 49}
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], [...Beat, hidden])
        const sibling = project.editing.modify(() => RegionEditing.cut(region, 2 * Bar, false))
            .unwrap("modify").unwrap("cut")
        const storedBefore = stored(region)
        const playedBefore = played(region)
        project.editing.modify(() => region.unloop())
        const collection = region.optCollection.unwrap("collection")
        expect(eventsOf(region).every(({box}) => box.isAttached())).toBe(true)
        expect(eventsOf(region).length).toBe(collection.box.events.pointerHub.incoming().length)
        expect(eventsOf(region).length).toBe(6)
        expect(played(region)).toEqual(playedBefore)
        // a consolidated copy reads the adapter's events, so a dead entry would come back as a live note
        const copy = project.editing.modify(() => region.copyTo({position: 4 * Bar, consolidate: true}))
            .unwrap("modify")
        expect(eventsOf(copy).some(({pitch}) => pitch === 49)).toBe(false)
        expect(eventsOf(copy).length).toBe(6)
        expect(stored(sibling)).toEqual(storedBefore)
        expect(project.editing.undo()).toBe(true)
        expect(project.editing.undo()).toBe(true)
        expect(region.isMirrowed).toBe(true)
        expect([region.position, region.duration, region.loopOffset, region.loopDuration])
            .toEqual([0, 2 * Bar, 0, Bar])
        expect(stored(region)).toEqual(storedBefore)
        expect(project.editing.redo()).toBe(true)
        expect(region.isMirrowed).toBe(false)
        expect(eventsOf(region).every(({box}) => box.isAttached())).toBe(true)
        expect(played(region)).toEqual(playedBefore)
        project.terminate()
    })

    it("a region that plays its content once is left alone", async () => {
        // One bar shown from one beat into a 4-bar loop: the loop never wraps inside the region.
        const notes: ReadonlyArray<Note> = [
            {position: 0, duration: 240, pitch: 36},
            {position: Quarter, duration: 240, pitch: 38},
            {position: 2 * Bar, duration: 240, pitch: 50}
        ]
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: Bar, loopOffset: Quarter, loopDuration: 4 * Bar}], notes)
        const before = stored(region)
        const ids = noteIds(region)
        project.editing.modify(() => region.unloop())
        expect(region.loopOffset).toBe(Quarter)
        expect(region.loopDuration).toBe(4 * Bar)
        expect(stored(region)).toEqual(before)
        expect(noteIds(region)).toEqual(ids)
        project.terminate()
    })

    it("a loop offset outside the loop length is judged by the passes the region plays", async () => {
        // A negative offset wraps once inside the region. An offset past the loop length does not wrap at all.
        const {project, regions: [wrapping, single]} = await buildProject([
            {position: 0, duration: Bar, loopOffset: -Quarter, loopDuration: Bar},
            {position: 0, duration: 2 * Quarter, loopOffset: Bar + Quarter, loopDuration: Bar}
        ], Beat)
        const wrappingBefore = played(wrapping)
        const singleBefore = stored(single)
        project.editing.modify(() => {
            wrapping.unloop()
            single.unloop()
        })
        expect([wrapping.loopOffset, wrapping.loopDuration]).toEqual([0, Bar])
        expect(stored(wrapping)).toEqual(["0:42:240", "960:36:240", "2880:38:240"])
        expect(played(wrapping)).toEqual(wrappingBefore)
        expect([single.loopOffset, single.loopDuration]).toEqual([Bar + Quarter, Bar])
        expect(stored(single)).toEqual(singleBefore)
        project.terminate()
    })

    it("the region stays open in the note editor and stays selected", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const {timeline} = project.userEditingManager
        timeline.edit(region.box)
        project.selection.select(region.box)
        expect(timeline.isEditing(region.box)).toBe(true)
        expect(project.selection.isSelected(region.box)).toBe(true)
        project.editing.modify(() => region.unloop())
        expect(timeline.isEditing(region.box)).toBe(true)
        expect(project.selection.isSelected(region.box)).toBe(true)
        expect(eventsOf(region).length).toBe(12)
        project.terminate()
    })

    it("a note crossing the loop line keeps its full length", async () => {
        // An open hat on beat 4 held for two beats, so it runs over the bar line in every pass.
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: 2 * Bar, loopOffset: 0, loopDuration: Bar}],
            [{position: 3 * Quarter, duration: 2 * Quarter, pitch: 46}])
        project.editing.modify(() => region.unloop())
        expect(stored(region)).toEqual(["2880:46:1920", "6720:46:1920"])
        project.terminate()
    })

    it("undo restores the loop and the original notes", async () => {
        const {project, regions: [region]} = await buildProject(
            [{position: Bar, duration: 4 * Bar, loopOffset: 0, loopDuration: Bar}], Beat)
        const before = stored(region)
        const ids = noteIds(region)
        const playedBefore = played(region)
        project.editing.modify(() => region.unloop())
        expect(eventsOf(region).length).toBe(12)
        expect(project.editing.undo()).toBe(true)
        expect([region.position, region.duration, region.loopOffset, region.loopDuration])
            .toEqual([Bar, 4 * Bar, 0, Bar])
        expect(stored(region)).toEqual(before)
        expect(noteIds(region)).toEqual(ids)
        expect(project.editing.redo()).toBe(true)
        expect(eventsOf(region).length).toBe(12)
        expect(played(region)).toEqual(playedBefore)
        project.terminate()
    })
})
