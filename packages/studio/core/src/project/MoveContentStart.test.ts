import {afterEach, describe, expect, it} from "vitest"
import {asInstanceOf, int, isDefined, isInstanceOf, Option, Terminable, unitValue, UUID} from "@opendaw/lib-std"
import {Event, LoopableRegion, ppqn, PPQN} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {
    NoteRegionBoxAdapter,
    ProjectSkeleton,
    TrackBoxAdapter,
    TrackType,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"
import {StudioPreferences} from "../StudioPreferences"

// moveContentStart is the region's lower-left handle (RegionContentStartModifier). It moved the events of the
// collection in place, so (1) a mirrored region moved the events of every region sharing that collection, and
// (2) a listener reading the events while they moved re-sorted the array under the walk, so some events moved
// twice and others not at all.

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

const {Bar, Quarter} = PPQN

type Span = { position: ppqn, duration: ppqn, loopOffset: ppqn, loopDuration: ppqn }
type Note = { position: ppqn, pitch: int }
type Point = { position: ppqn, value: unitValue }

// One collection with an event on each of bars 1-4. The left region shows bars 1-2, the right one bars 3-4.
const Mirrors: ReadonlyArray<Span> = [
    {position: 0, duration: 2 * Bar, loopOffset: 0, loopDuration: 4 * Bar},
    {position: 2 * Bar, duration: 2 * Bar, loopOffset: 2 * Bar, loopDuration: 4 * Bar}
]
const BarNotes: ReadonlyArray<Note> = [0, 1, 2, 3].map(index => ({position: index * Bar, pitch: 60 + index}))
const BarPoints: ReadonlyArray<Point> = [0, 1, 2, 3].map(index => ({position: index * Bar, value: index / 4}))

// A one-bar region on bar 3 with an event on each beat.
const Single: ReadonlyArray<Span> = [{position: 2 * Bar, duration: Bar, loopOffset: 0, loopDuration: Bar}]
const BeatNotes: ReadonlyArray<Note> = [0, 1, 2, 3].map(index => ({position: index * Quarter, pitch: 60 + index}))
const BeatPoints: ReadonlyArray<Point> = [0, 1, 2, 3].map(index => ({position: index * Quarter, value: index / 4}))

// The beat events after moveContentStart(-Bar): a bar later inside the region, which now starts a bar earlier.
const BeatNotesBarLater = BeatNotes.map(({position, pitch}) => [position + Bar, pitch])
const BeatPointsBarLater = BeatPoints.map(({position, value}) => [position + Bar, value])

const buildTrack = async (type: TrackType, populate: (boxGraph: BoxGraph, trackBox: TrackBox) => void) => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(type)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(type === TrackType.Value ? primaryAudioUnitBox.volume : primaryAudioUnitBox)
    })
    populate(boxGraph, trackBox)
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const track = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackBox, track}
}

const buildNoteRegions = async (notes: ReadonlyArray<Note>, spans: ReadonlyArray<Span>) => {
    const {project, trackBox, track} = await buildTrack(TrackType.Notes, (boxGraph, trackBox) => {
        const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        notes.forEach(({position, pitch}) => NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(Quarter / 2)
            box.pitch.setValue(pitch)
            box.events.refer(collection.events)
        }))
        spans.forEach(({position, duration, loopOffset, loopDuration}) =>
            NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopOffset.setValue(loopOffset)
                box.loopDuration.setValue(loopDuration)
                box.regions.refer(trackBox.regions)
                box.events.refer(collection.owners)
            }))
    })
    const regions = track.regions.collection.asArray().map(region => asInstanceOf(region, NoteRegionBoxAdapter))
    return {project, trackBox, track, regions}
}

const buildValueRegions = async (points: ReadonlyArray<Point>, spans: ReadonlyArray<Span>) => {
    const {project, track} = await buildTrack(TrackType.Value, (boxGraph, trackBox) => {
        const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        points.forEach(({position, value}) => ValueEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.value.setValue(value)
            box.events.refer(collection.events)
        }))
        spans.forEach(({position, duration, loopOffset, loopDuration}) =>
            ValueRegionBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopOffset.setValue(loopOffset)
                box.loopDuration.setValue(loopDuration)
                box.regions.refer(trackBox.regions)
                box.events.refer(collection.owners)
            }))
    })
    const regions = track.regions.collection.asArray().map(region => asInstanceOf(region, ValueRegionBoxAdapter))
    return {project, track, regions}
}

// Every event the region plays, as [timeline position, pitch or value].
const heard = <E extends Event, V>(region: LoopableRegion.Region, events: ReadonlyArray<E>, read: (event: E) => V) => {
    const result: Array<[ppqn, V]> = []
    for (const {rawStart, resultStart, resultEnd} of LoopableRegion.locateLoops(region, region.position, region.complete)) {
        events.forEach(event => {
            const position = rawStart + event.position
            if (position >= resultStart && position < resultEnd) {result.push([position, read(event)])}
        })
    }
    return result
}
const notesOf = (region: NoteRegionBoxAdapter) =>
    heard(region, region.optCollection.unwrap("notes").events.asArray(), event => event.pitch)
const pointsOf = (region: ValueRegionBoxAdapter) =>
    heard(region, region.optCollection.unwrap("points").events.asArray(), event => event.value)

// Every event as stored in the collection, as [local position, pitch or value].
const storedNotes = (region: NoteRegionBoxAdapter) =>
    region.optCollection.unwrap("notes").events.asArray().map(({position, pitch}) => [position, pitch])
const storedPoints = (region: ValueRegionBoxAdapter) =>
    region.optCollection.unwrap("points").events.asArray().map(({position, value}) => [position, value])

// A ratchet on every note, with every property Consolidate copies off its default.
const Ratchet = {velocity: 0.5, cent: 25, chance: 50, playCount: 4}
const setRatchets = (region: NoteRegionBoxAdapter) =>
    region.optCollection.unwrap("notes").events.asArray().forEach(({box}) => {
        box.velocity.setValue(Ratchet.velocity)
        box.cent.setValue(Ratchet.cent)
        box.chance.setValue(Ratchet.chance)
        box.playCount.setValue(Ratchet.playCount)
    })
const ratchetsOf = (region: NoteRegionBoxAdapter) => region.optCollection.unwrap("notes").events.asArray()
    .map(({velocity, cent, chance, playCount}) => ({velocity, cent, chance, playCount}))

afterEach(() => StudioPreferences.settings.editing["overlapping-regions-behaviour"] = "clip")

describe("moveContentStart on a mirrored region", () => {
    it("moving the content start of one mirrored note region leaves the other's notes where they were", async () => {
        const {project, regions: [left, right]} = await buildNoteRegions(BarNotes, Mirrors)
        expect(notesOf(left)).toEqual([[0, 60], [Bar, 61]])
        project.editing.modify(() => right.moveContentStart(Bar))
        expect(notesOf(left)).toEqual([[0, 60], [Bar, 61]])
        expect(notesOf(right)).toEqual([[3 * Bar, 63]])
        expect(left.isMirrowed).toBe(false)
        expect(right.isMirrowed).toBe(false)
        project.terminate()
    })

    it("moving the content start of one mirrored value region leaves the other's points where they were", async () => {
        const {project, regions: [left, right]} = await buildValueRegions(BarPoints, Mirrors)
        expect(pointsOf(left)).toEqual([[0, 0], [Bar, 0.25]])
        project.editing.modify(() => right.moveContentStart(Bar))
        expect(pointsOf(left)).toEqual([[0, 0], [Bar, 0.25]])
        expect(pointsOf(right)).toEqual([[3 * Bar, 0.75]])
        expect(left.isMirrowed).toBe(false)
        expect(right.isMirrowed).toBe(false)
        project.terminate()
    })

    it("moving the content start of both selected mirrors moves each region's notes once", async () => {
        const {project, regions} = await buildNoteRegions(BarNotes, Mirrors)
        const [left, right] = regions
        project.editing.modify(() => regions.forEach(region => region.moveContentStart(Quarter)))
        expect(notesOf(left)).toEqual([[Bar, 61]])
        expect(notesOf(right)).toEqual([[3 * Bar, 63]])
        project.terminate()
    })

    it("a piece carved out by drawing a region over it moves its content start without changing the other piece", async () => {
        StudioPreferences.settings.editing["overlapping-regions-behaviour"] = "clip"
        const eightBars: ReadonlyArray<Note> = [0, 1, 2, 3, 4, 5, 6, 7]
            .map(index => ({position: index * Bar, pitch: 36 + index}))
        const {project, trackBox, track} = await buildNoteRegions(eightBars,
            [{position: 0, duration: 8 * Bar, loopOffset: 0, loopDuration: 8 * Bar}])
        project.editing.modify(() => project.api.createTrackRegion(trackBox, 4 * Bar, Bar))
        const [first, , rest] = track.regions.collection.asArray()
            .map(region => asInstanceOf(region, NoteRegionBoxAdapter))
        expect(first.isMirrowed).toBe(true)
        expect(notesOf(first)).toEqual([[0, 36], [Bar, 37], [2 * Bar, 38], [3 * Bar, 39]])
        project.editing.modify(() => rest.moveContentStart(Bar))
        expect(notesOf(first)).toEqual([[0, 36], [Bar, 37], [2 * Bar, 38], [3 * Bar, 39]])
        expect(notesOf(rest)).toEqual([[6 * Bar, 42], [7 * Bar, 43]])
        project.terminate()
    })

    it("the region whose content start moved keeps every note at the same timeline position", async () => {
        const {project, regions: [, right]} = await buildNoteRegions(BarNotes, Mirrors)
        project.editing.modify(() => right.moveContentStart(-Bar))
        expect(notesOf(right)).toEqual([[Bar, 61], [2 * Bar, 62], [3 * Bar, 63]])
        project.terminate()
    })

    it("a mirrored region keeps its notes' properties through a content-start drag", async () => {
        const {project, regions: [left, right]} = await buildNoteRegions(BarNotes, Mirrors)
        project.editing.modify(() => setRatchets(left))
        project.editing.modify(() => right.moveContentStart(Bar))
        expect(ratchetsOf(right)).toEqual(BarNotes.map(() => Ratchet))
        expect(ratchetsOf(left)).toEqual(BarNotes.map(() => Ratchet))
        project.terminate()
    })

    it("moving the content start of a mirrored region by zero keeps the link", async () => {
        const notes = await buildNoteRegions(BarNotes, Mirrors)
        const points = await buildValueRegions(BarPoints, Mirrors)
        const [noteLeft, noteRight] = notes.regions
        const [valueLeft, valueRight] = points.regions
        const noteCollection = noteLeft.optCollection.unwrap("notes")
        const valueCollection = valueLeft.optCollection.unwrap("points")
        notes.project.editing.modify(() => noteRight.moveContentStart(0))
        points.project.editing.modify(() => valueRight.moveContentStart(0))
        expect(noteRight.optCollection.unwrap("notes")).toBe(noteCollection)
        expect(valueRight.optCollection.unwrap("points")).toBe(valueCollection)
        expect(notesOf(noteRight)).toEqual([[2 * Bar, 62], [3 * Bar, 63]])
        expect(pointsOf(valueRight)).toEqual([[2 * Bar, 0.5], [3 * Bar, 0.75]])
        notes.project.terminate()
        points.project.terminate()
    })

    it("a region that is not mirrored keeps its own collection", async () => {
        const {project, regions: [region]} = await buildNoteRegions(BeatNotes, Single)
        const collection = region.optCollection.unwrap("collection")
        const countCollections = () => project.boxGraph.boxes()
            .filter(box => isInstanceOf(box, NoteEventCollectionBox)).length
        const collections = countCollections()
        project.editing.modify(() => region.moveContentStart(Quarter))
        expect(region.optCollection.unwrap("collection")).toBe(collection)
        expect(countCollections()).toBe(collections)
        project.terminate()
    })

    it("one undo restores the link and what both regions play", async () => {
        const {project, regions: [left, right]} = await buildNoteRegions(BarNotes, Mirrors)
        const collection = left.optCollection.unwrap("collection")
        project.editing.modify(() => right.moveContentStart(Bar))
        project.editing.undo()
        expect(left.optCollection.unwrap("left")).toBe(collection)
        expect(right.optCollection.unwrap("right")).toBe(collection)
        expect(right.isMirrowed).toBe(true)
        expect(notesOf(left)).toEqual([[0, 60], [Bar, 61]])
        expect(notesOf(right)).toEqual([[2 * Bar, 62], [3 * Bar, 63]])
        project.terminate()
    })
})

describe("moveContentStart while a listener reads the events", () => {
    it("moving a note region's content start a bar earlier moves each note once while a listener reads the notes", async () => {
        const {project, regions: [region]} = await buildNoteRegions(BeatNotes, Single)
        const subscription = region.subscribeChange(() =>
            region.optCollection.ifSome(collection => collection.events.asArray()))
        project.editing.modify(() => region.moveContentStart(-Bar))
        subscription.terminate()
        expect(storedNotes(region)).toEqual(BeatNotesBarLater)
        expect(notesOf(region)).toEqual(BeatNotes.map(({position, pitch}) => [2 * Bar + position, pitch]))
        project.terminate()
    })

    it("moving a value region's content start a bar earlier keeps every point while the value editor watches it", async () => {
        const {project, regions: [region]} = await buildValueRegions(BeatPoints, Single)
        const events = region.optCollection.unwrap("points").events
        const segment = events.asArray()[3]
        // ValueEditor clears its selected curve segment once the region no longer contains it
        const subscription = region.subscribeChange(() => events.contains(segment))
        project.editing.modify(() => region.moveContentStart(-Bar))
        subscription.terminate()
        expect(storedPoints(region)).toEqual(BeatPointsBarLater)
        project.terminate()
    })

    it("moving the content start a bar earlier without a listener moves each event once", async () => {
        const notes = await buildNoteRegions(BeatNotes, Single)
        const points = await buildValueRegions(BeatPoints, Single)
        const [noteRegion] = notes.regions
        const [valueRegion] = points.regions
        notes.project.editing.modify(() => noteRegion.moveContentStart(-Bar))
        points.project.editing.modify(() => valueRegion.moveContentStart(-Bar))
        expect(storedNotes(noteRegion)).toEqual(BeatNotesBarLater)
        expect(storedPoints(valueRegion)).toEqual(BeatPointsBarLater)
        notes.project.terminate()
        points.project.terminate()
    })
})
