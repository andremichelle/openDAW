import {describe, expect, it} from "vitest"
import {int, isDefined, Option, Selection, Terminable, UUID, ValueAxis} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AnyClipBoxAdapter, AnyRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {
    NoteClipBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueClipBox, ValueEventCollectionBox, ValueRegionBox
} from "@opendaw/studio-boxes"
import type {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

// Live error 1226: `track@idx` from RegionMoveModifier.approve. TracksManager assigns `listIndex` only to the tracks
// in its sorted list, a track that leaves the list (a value lane hidden by collapsed automation) keeps its old index.
// With a region on that lane still selected, `update` clamps the delta once per region in turn, and a stale index
// past the end drags the delta below what the top region allows. Approve then looks up index -1.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createSelection = <T extends AnyRegionBoxAdapter | AnyClipBoxAdapter>(): Selection<T> => {
    const selected: Array<T> = []
    const selection = {
        select: (...regions: Array<T>) => regions.forEach(region => {
            if (selected.includes(region)) {return}
            selected.push(region)
            region.onSelected()
        }),
        deselect: (...regions: Array<T>) => regions.forEach(region => {
            const index = selected.indexOf(region)
            if (index === -1) {return}
            selected.splice(index, 1)
            region.onDeselected()
        }),
        deselectAll: () => selection.deselect(...selected.slice()),
        isSelected: (region: T) => selected.includes(region),
        isEmpty: () => selected.length === 0,
        nonEmpty: () => selected.length > 0,
        count: () => selected.length,
        selected: () => selected,
        distance: () => [],
        subscribe: () => Terminable.Empty,
        catchupAndSubscribe: () => Terminable.Empty
    }
    return selection
}

const setup = async () => {
    const {Project, TimelineRange} = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const {RegionMoveModifier} = await import("./RegionMoveModifier.ts")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const noteTrackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.index.setValue(0)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const valueTrackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.index.setValue(1)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const noteEvents = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.loopDuration.setValue(PPQN.Bar)
        box.regions.refer(noteTrackBox.regions)
        box.events.refer(noteEvents.owners)
    })
    const valueEvents = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    ValueRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.loopDuration.setValue(PPQN.Bar)
        box.regions.refer(valueTrackBox.regions)
        box.events.refer(valueEvents.owners)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    const noteTrack = project.boxAdapters.adapterFor(noteTrackBox, TrackBoxAdapter)
    const valueTrack = project.boxAdapters.adapterFor(valueTrackBox, TrackBoxAdapter)
    // Both lanes were listed (indices 0 and 1), then the automation was collapsed: the value lane left the list
    // and, like in TracksManager.#invalidateOrder, only the listed track got its index reassigned.
    noteTrack.listIndex = 0
    valueTrack.listIndex = 1
    const listed: ReadonlyArray<TrackBoxAdapter> = [noteTrack]
    const manager = {
        service: {project},
        numTracks: () => listed.length,
        globalToIndex: (clientY: number) => clientY,
        getByIndex: (index: int) => Option.wrap(listed[index]).map(trackBoxAdapter => ({trackBoxAdapter}))
    } as unknown as TracksManager
    const noteRegion = noteTrack.regions.collection.asArray()[0] as AnyRegionBoxAdapter
    const valueRegion = valueTrack.regions.collection.asArray()[0] as AnyRegionBoxAdapter
    const selection = createSelection<AnyRegionBoxAdapter>()
    selection.select(noteRegion, valueRegion)
    const range = new TimelineRange({padding: 0})
    range.maxUnits = PPQN.fromSignature(64, 4)
    range.width = 65536
    range.showAll()
    const snapping = new Snapping(range)
    const element = {getBoundingClientRect: () => ({left: 0})} as unknown as Element
    const modifier = RegionMoveModifier.create(manager, selection, {
        element, snapping, pointerPulse: 0, pointerIndex: 0, reference: noteRegion
    }).unwrap("move")
    return {modifier, range, noteTrack, valueTrack, noteRegion, valueRegion}
}

describe("RegionMoveModifier with a selected region on a lane that left the track list (1226)", () => {
    it("dragging one track up from the top track neither panics nor moves anything", async () => {
        const {modifier, range, noteTrack, valueTrack, noteRegion, valueRegion} = await setup()
        modifier.update({clientX: range.unitToX(0), clientY: -1, altKey: false, ctrlKey: false, shiftKey: false})
        expect(() => modifier.approve()).not.toThrow()
        expect(noteRegion.trackBoxAdapter.unwrap()).toBe(noteTrack)
        expect(valueRegion.trackBoxAdapter.unwrap()).toBe(valueTrack)
        expect(noteRegion.position).toBe(0)
        expect(valueRegion.position).toBe(0)
    })
})

const setupClips = async () => {
    const {Project} = await import("@opendaw/studio-core")
    const {ClipMoveModifier} = await import("../clips/ClipMoveModifier.ts")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const noteTrackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.index.setValue(0)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const valueTrackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.index.setValue(1)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const noteEvents = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteClipBox.create(boxGraph, UUID.generate(), box => {
        box.index.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.clips.refer(noteTrackBox.clips)
        box.events.refer(noteEvents.owners)
    })
    const valueEvents = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    ValueClipBox.create(boxGraph, UUID.generate(), box => {
        box.index.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.clips.refer(valueTrackBox.clips)
        box.events.refer(valueEvents.owners)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    const noteTrack = project.boxAdapters.adapterFor(noteTrackBox, TrackBoxAdapter)
    const valueTrack = project.boxAdapters.adapterFor(valueTrackBox, TrackBoxAdapter)
    noteTrack.listIndex = 0
    valueTrack.listIndex = 1
    const tracks = [{trackBoxAdapter: noteTrack}]
    const manager = {
        tracks: () => tracks,
        numTracks: () => tracks.length,
        maxClipsIndex: {getValue: () => 16},
        getByIndex: (index: int) => Option.wrap(tracks[index])
    } as unknown as TracksManager
    const noteClip = noteTrack.clips.collection.getAdapterByIndex(0).unwrap("note clip")
    const valueClip = valueTrack.clips.collection.getAdapterByIndex(0).unwrap("value clip")
    const selection = createSelection<AnyClipBoxAdapter>()
    selection.select(noteClip, valueClip)
    const axis: ValueAxis = {axisToValue: (axis: number) => axis, valueToAxis: (value: number) => value}
    const modifier = ClipMoveModifier.start({
        project, manager, selection, xAxis: axis, yAxis: axis, pointerClipIndex: 0, pointerTrackIndex: 0
    }).unwrap("move")
    return {modifier, noteTrack, valueTrack, noteClip, valueClip}
}

describe("ClipMoveModifier with a selected clip on a lane that left the track list (1226 sibling)", () => {
    it("dragging up and right from the top track moves the listed clip only along its track", async () => {
        const {modifier, noteTrack, valueTrack, noteClip, valueClip} = await setupClips()
        modifier.update({clientX: 1, clientY: -1, altKey: false, ctrlKey: false, shiftKey: false})
        expect(() => modifier.approve()).not.toThrow()
        expect(noteClip.trackBoxAdapter.unwrap()).toBe(noteTrack)
        expect(noteClip.indexField.getValue()).toBe(1)
        expect(valueClip.trackBoxAdapter.unwrap()).toBe(valueTrack)
        expect(valueClip.indexField.getValue()).toBe(0)
    })
})
