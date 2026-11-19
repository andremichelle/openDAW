import {describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, NoteRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {ChordEventBox, KeyEventBox, MarkerBox, NoteEventCollectionBox, NoteRegionBox, ValueEventBox} from "@opendaw/studio-boxes"
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

describe("TimeEditing tempo", () => {
    const createTempo = (project: Project, points: ReadonlyArray<[number, number]>): void => {
        const {boxGraph} = project
        const collection = project.timelineBoxAdapter.tempoTrackEvents.unwrap("tempo track").box
        project.editing.modify(() => {
            collection.events.pointerHub.incoming().forEach(pointer => pointer.box.delete())
            points.forEach(([position, value]) => ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.events.refer(collection.events)
                box.position.setValue(position)
                box.value.setValue(value)
            }))
        })
    }
    const tempo = (project: Project): ReadonlyArray<[number, number]> => project.timelineBoxAdapter.tempoTrackEvents
        .mapOr(({events}) => events.asArray().map(event => [event.position, event.value]), [])
    it("deletes from the first tempo event to a later one without clashing", async () => {
        const project = await createProject()
        createTempo(project, [[0, 70], [1000, 90], [2000, 110], [3840, 130], [5000, 150]])
        project.editing.modify(() => TimeEditing.deleteTime([], global(project), 0, 3840))
        expect(tempo(project)).toEqual([[0, 130], [1160, 150]])
        project.editing.undo()
        expect(tempo(project)).toEqual([[0, 70], [1000, 90], [2000, 110], [3840, 130], [5000, 150]])
        project.terminate()
    })
    it("cuts a ramp with one node on the tempo curve", async () => {
        const project = await createProject()
        createTempo(project, [[0, 70], [1000, 90], [2000, 110]])
        project.editing.modify(() => TimeEditing.deleteTime([], global(project), 500, 1500))
        const result = tempo(project)
        expect(result.map(([position]) => position)).toEqual([0, 500, 1000])
        expect(result[1][1]).toBeCloseTo(70 * Math.sqrt(90 / 70))
        expect(result[2][1]).toBe(110)
        project.terminate()
    })
    it("leaves a single node at the cut when deleting to the end", async () => {
        const project = await createProject()
        createTempo(project, [[0, 120], [3840 * 3, 140]])
        project.editing.modify(() => TimeEditing.deleteTime([], global(project), 3840, 3840 * 8))
        const result = tempo(project)
        expect(result.map(([position]) => position)).toEqual([0, 3840])
        expect(result[1][1]).toBeCloseTo(120 * Math.pow(140 / 120, 1 / 3))
        project.terminate()
    })
    it("holds the tempo at the insert point during inserted time", async () => {
        const project = await createProject()
        createTempo(project, [[0, 100], [2000, 120]])
        project.editing.modify(() => TimeEditing.insertTime([], global(project), 1000, 960))
        const result = tempo(project)
        expect(result.map(([position]) => position)).toEqual([0, 1000, 1960, 2960])
        expect(result[1][1]).toBeCloseTo(Math.sqrt(100 * 120))
        expect(result[2][1]).toBeCloseTo(Math.sqrt(100 * 120))
        project.terminate()
    })
    it("pushes tempo events on insert", async () => {
        const project = await createProject()
        createTempo(project, [[0, 70], [1000, 90]])
        project.editing.modify(() => TimeEditing.insertTime([], global(project), 0, 960))
        expect(tempo(project)).toEqual([[960, 70], [1960, 90]])
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

describe("TimeEditing.insertRegion", () => {
    it("pushes and fills the inserted time with an empty note region", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 0, 1920)
        project.editing.modify(() => TimeEditing.insertRegion(project.api, [track], [], 960, 480))
        expect(spans(track)).toEqual([[0, 960], [960, 1440], [1440, 2400]])
        const inserted = track.regions.collection.asArray()[1]
        expect(inserted.type).toBe("note-region")
        expect(inserted.isNoteRegion() && inserted.optCollection.unwrap().events.asArray().length).toBe(0)
        project.terminate()
    })
    it("creates one region per track", async () => {
        const project = await createProject()
        const tracks = createTracks(project, 2)
        project.editing.modify(() => TimeEditing.insertRegion(project.api, tracks, [], 0, 960))
        tracks.forEach(track => expect(spans(track)).toEqual([[0, 960]]))
        project.terminate()
    })
    it("is undone in one step", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        createRegion(project, track, 0, 960)
        project.editing.modify(() => TimeEditing.insertRegion(project.api, [track], [], 0, 960))
        expect(spans(track)).toEqual([[0, 960], [960, 1920]])
        project.editing.undo()
        expect(spans(track)).toEqual([[0, 960]])
        project.terminate()
    })
    it("creates nothing for an empty range", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        project.editing.modify(() => TimeEditing.insertRegion(project.api, [track], [], 0, 0))
        expect(spans(track)).toEqual([])
        project.terminate()
    })
    it("is only available with a note or value track", async () => {
        const project = await createProject()
        const [track] = createTracks(project, 1)
        const audioTrackBox = project.editing.modify(() =>
            project.api.createAudioTrack(track.audioUnit)).unwrap()
        const audio = project.boxAdapters.adapterFor(audioTrackBox, TrackBoxAdapter)
        expect(TimeEditing.canInsertRegion([track])).toBe(true)
        expect(TimeEditing.canInsertRegion([audio])).toBe(false)
        expect(TimeEditing.canInsertRegion([audio, track])).toBe(true)
        expect(TimeEditing.canInsertRegion([])).toBe(false)
        project.terminate()
    })
})

describe("InaudibleContent", () => {
    it("finds the notes the cut pieces can no longer play", async () => {
        const {InaudibleContent} = await import("./InaudibleContent")
        const project = await createProject()
        const [track] = createTracks(project, 1)
        const region = createRegion(project, track, 0, 3840)
        project.editing.modify(() => [0, 960, 1920, 2880].forEach(position =>
            region.optCollection.unwrap().createEvent({position, duration: 240, pitch: 60, velocity: 1, cent: 0, chance: 100, playCount: 1, playCurve: 0})))
        const predicted = InaudibleContent.count([region], [960, 1920], (start, end) => start >= 960 && end <= 1920)
        const touched = project.editing.modify(() => TimeEditing.deleteTime([track], [], 960, 1920)).unwrap()
        const inaudible = InaudibleContent.collect(touched)
        expect(predicted).toBe(inaudible.length)
        expect(inaudible.map(event => event.position).sort((a, b) => a - b)).toEqual([0, 960, 960, 1920, 2880])
        project.editing.modify(() => inaudible.forEach(event => event.box.delete()))
        expect(InaudibleContent.collect(touched)).toHaveLength(0)
        project.terminate()
    })
    it("never touches content shared with another region", async () => {
        const {InaudibleContent} = await import("./InaudibleContent")
        const project = await createProject()
        const [track, other] = createTracks(project, 2)
        const region = createRegion(project, track, 0, 3840)
        const mirror = project.boxAdapters.adapterFor(project.editing.modify(() => NoteRegionBox.create(project.boxGraph, UUID.generate(), box => {
            box.regions.refer(other.box.regions)
            box.events.refer(region.optCollection.unwrap().box.owners)
            box.duration.setValue(3840)
            box.loopDuration.setValue(3840)
        })).unwrap(), NoteRegionBoxAdapter)
        project.editing.modify(() => [0, 960, 1920, 2880].forEach(position =>
            region.optCollection.unwrap().createEvent({position, duration: 240, pitch: 60, velocity: 1, cent: 0, chance: 100, playCount: 1, playCurve: 0})))
        const predicted = InaudibleContent.count([region], [1920], () => false)
        const touched = project.editing.modify(() => TimeEditing.insertTime([track], [], 1920, 960)).unwrap()
        const inaudible = InaudibleContent.collect(touched)
        expect(predicted).toBe(2)
        expect(inaudible).toHaveLength(2)
        project.editing.modify(() => inaudible.forEach(event => event.box.delete()))
        expect(mirror.optCollection.unwrap().events.asArray()).toHaveLength(4)
        project.terminate()
    })
    it("computes the audible windows of a region, including a wrapped loop", async () => {
        const {InaudibleContent} = await import("./InaudibleContent")
        const project = await createProject()
        const [track] = createTracks(project, 1)
        const region = createRegion(project, track, 0, 3840)
        expect(InaudibleContent.windowsOf(region)).toEqual([{start: 0, end: 3840}])
        project.editing.modify(() => region.box.duration.setValue(960))
        project.editing.modify(() => region.box.loopOffset.setValue(3000))
        expect(InaudibleContent.windowsOf(region)).toEqual([{start: 3000, end: 3840}, {start: 0, end: 120}])
        project.terminate()
    })
})
