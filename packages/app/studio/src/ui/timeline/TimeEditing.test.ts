import {describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, NoteRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {ChordEventBox, KeyEventBox, MarkerBox, NoteEventCollectionBox, NoteRegionBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import {TimeEditing} from "./TimeEditing"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})
const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createProject = async (): Promise<Project> => {
    const {Project} = await import("@opendaw/studio-core")
    return Project.fromSkeleton({
            audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
            soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
        } as unknown as Parameters<typeof Project.fromSkeleton>[0],
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const createTracks = (project: Project, count: number): ReadonlyArray<TrackBoxAdapter> =>
    project.editing.modify(() => Array.from({length: count}, () => project.api.createAnyInstrument(InstrumentFactories.Neon)))
        .unwrap().map(({trackBox}) => project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter))

// [position, duration, loopDuration]
const createRegion = (project: Project, track: TrackBoxAdapter, position: number, duration: number,
                      loopDuration: number = duration): NoteRegionBoxAdapter =>
    project.boxAdapters.adapterFor(project.editing.modify(() => {
        const events = NoteEventCollectionBox.create(project.boxGraph, UUID.generate())
        return NoteRegionBox.create(project.boxGraph, UUID.generate(), box => {
            box.regions.refer(track.box.regions)
            box.events.refer(events.owners)
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopDuration.setValue(loopDuration)
        })
    }).unwrap(), NoteRegionBoxAdapter)

const spans = (track: TrackBoxAdapter): ReadonlyArray<[number, number]> =>
    track.regions.collection.asArray().map(region => [region.position, region.complete])

const global = (project: Project): ReadonlyArray<TimeEditing.Global> =>
    [{timeline: project.timelineBoxAdapter, boxGraph: project.boxGraph}]

describe("TimeEditing.deleteTime", () => {
    it("closes an empty gap", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 0, 960)
        createRegion(project, track, 1920, 960)
        project.editing.modify(() => TimeEditing.deleteTime([track], [], 960, 1920))
        expect(spans(track)).toEqual([[0, 960], [960, 1920]])
        project.terminate()
    })
    it("cuts a region crossing both edges and keeps the loop phase", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 0, 3840, 960)
        project.editing.modify(() => TimeEditing.deleteTime([track], [], 480, 1440))
        expect(spans(track)).toEqual([[0, 480], [480, 2880]])
        const [, right] = track.regions.collection.asArray()
        expect(right.loopOffset).toBe(480)
        project.terminate()
    })
    it("removes regions fully inside and pulls later ones", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 960, 480)
        createRegion(project, track, 3840, 960)
        project.editing.modify(() => TimeEditing.deleteTime([track], [], 960, 1920))
        expect(spans(track)).toEqual([[2880, 3840]])
        project.terminate()
    })
    it("leaves tracks outside the selection untouched", async () => {
        const project = await createProject()
        const [selected, other] = createTracks(project, 2)
        createRegion(project, selected, 1920, 960)
        createRegion(project, other, 1920, 960)
        project.editing.modify(() => TimeEditing.deleteTime([selected], [], 0, 960))
        expect(spans(selected)).toEqual([[960, 1920]])
        expect(spans(other)).toEqual([[1920, 2880]])
        project.terminate()
    })
    it("does nothing for an empty range", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 0, 1920)
        project.editing.modify(() => TimeEditing.deleteTime([track], [], 960, 960))
        expect(spans(track)).toEqual([[0, 1920]])
        project.terminate()
    })
    it("is undone in one step", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 0, 3840)
        createRegion(project, track, 3840, 960)
        project.editing.modify(() => TimeEditing.deleteTime([track], [], 960, 1920))
        expect(spans(track)).toEqual([[0, 960], [960, 2880], [2880, 3840]])
        project.editing.undo()
        expect(spans(track)).toEqual([[0, 3840], [3840, 4800]])
        project.terminate()
    })
    it("moves and removes markers, keys and chords", async () => {
        const project = await createProject()
        const {timelineBox, boxGraph} = project
        project.editing.modify(() => {
            ;[0, 1000, 2000].forEach(position => MarkerBox.create(boxGraph, UUID.generate(), box => {
                box.track.refer(timelineBox.markerTrack.markers)
                box.position.setValue(position)
            }))
            ;[0, 1500, 3000].forEach(position => KeyEventBox.create(boxGraph, UUID.generate(), box => {
                box.track.refer(timelineBox.keyTrack.events)
                box.position.setValue(position)
            }))
            ;[[0, 1440], [1200, 300], [1800, 960]].forEach(([position, duration]) =>
                ChordEventBox.create(boxGraph, UUID.generate(), box => {
                    box.track.refer(timelineBox.chordTrack.events)
                    box.position.setValue(position)
                    box.duration.setValue(duration)
                }))
        })
        project.editing.modify(() => TimeEditing.deleteTime([], global(project), 960, 1920))
        const timeline = project.timelineBoxAdapter
        expect(timeline.markerTrack.events.asArray().map(marker => marker.position)).toEqual([0, 1040])
        expect(timeline.keyTrack.events.asArray().map(key => key.position)).toEqual([0, 960, 2040])
        expect(timeline.chordTrack.events.asArray().map(chord => [chord.position, chord.complete]))
            .toEqual([[0, 960], [960, 1800]])
        project.terminate()
    })
    it("drops a signature change replaced by one at the range end", async () => {
        const project = await createProject()
        const {signatureTrack} = project.timelineBoxAdapter
        project.editing.modify(() => signatureTrack.createEvent(3840, 3, 4))
        project.editing.modify(() => signatureTrack.createEvent(6720, 4, 4))
        expect(Array.from(signatureTrack.iterateAll()).slice(1).map(event => [event.accumulatedPpqn, event.nominator]))
            .toEqual([[3840, 3], [6720, 4]])
        project.editing.modify(() => TimeEditing.deleteTime([], global(project), 3840, 6720))
        const events = Array.from(signatureTrack.iterateAll()).slice(1)
        expect(events.map(event => [event.accumulatedPpqn, event.nominator])).toEqual([[3840, 4]])
        project.terminate()
    })
})

describe("TimeEditing.mapStates via keys", () => {
    it("keeps the last state inside the range at its start unless one follows at its end", async () => {
        const project = await createProject()
        const {timelineBox, boxGraph} = project
        project.editing.modify(() => [0, 1000, 1500, 1920, 3000].forEach(position =>
            KeyEventBox.create(boxGraph, UUID.generate(), box => {
                box.track.refer(timelineBox.keyTrack.events)
                box.position.setValue(position)
                box.root.setValue(position % 12)
            })))
        project.editing.modify(() => TimeEditing.deleteTime([], global(project), 960, 1920))
        expect(project.timelineBoxAdapter.keyTrack.events.asArray().map(key => [key.position, key.box.root.getValue()]))
            .toEqual([[0, 0], [960, 1920 % 12], [2040, 3000 % 12]])
        project.terminate()
    })
})

describe("TimeEditing.insertTime", () => {
    it("splits a crossing region and pushes everything after", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 0, 1920, 960)
        createRegion(project, track, 1920, 960)
        project.editing.modify(() => TimeEditing.insertTime([track], [], 480, 960))
        expect(spans(track)).toEqual([[0, 480], [1440, 2880], [2880, 3840]])
        expect(track.regions.collection.asArray()[1].loopOffset).toBe(480)
        project.terminate()
    })
    it("only moves the given tracks", async () => {
        const project = await createProject()
        const [selected, other] = createTracks(project, 2)
        createRegion(project, selected, 960, 960)
        createRegion(project, other, 960, 960)
        project.editing.modify(() => TimeEditing.insertTime([selected], [], 0, 960))
        expect(spans(selected)).toEqual([[1920, 2880]])
        expect(spans(other)).toEqual([[960, 1920]])
        project.terminate()
    })
    it("pushes markers and splits a crossing chord", async () => {
        const project = await createProject()
        const {timelineBox, boxGraph} = project
        project.editing.modify(() => {
            MarkerBox.create(boxGraph, UUID.generate(), box => {
                box.track.refer(timelineBox.markerTrack.markers)
                box.position.setValue(960)
            })
            ChordEventBox.create(boxGraph, UUID.generate(), box => {
                box.track.refer(timelineBox.chordTrack.events)
                box.position.setValue(0)
                box.duration.setValue(1920)
                box.degree.setValue(5)
            })
        })
        project.editing.modify(() => TimeEditing.insertTime([], global(project), 960, 480))
        const timeline = project.timelineBoxAdapter
        expect(timeline.markerTrack.events.asArray().map(marker => marker.position)).toEqual([1440])
        expect(timeline.chordTrack.events.asArray().map(chord => [chord.position, chord.complete, chord.degree]))
            .toEqual([[0, 960, 5], [1440, 2400, 5]])
        project.terminate()
    })
    it("pushes signature changes by whole bars", async () => {
        const project = await createProject()
        const {signatureTrack} = project.timelineBoxAdapter
        project.editing.modify(() => signatureTrack.createEvent(3840, 3, 4))
        project.editing.modify(() => TimeEditing.insertTime([], global(project), 0, 3840))
        const events = Array.from(signatureTrack.iterateAll()).slice(1)
        expect(events.map(event => [event.accumulatedPpqn, event.nominator])).toEqual([[7680, 3]])
        project.terminate()
    })
})
