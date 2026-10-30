import {describe, expect, it} from "vitest"
import {int, isDefined, Option, Selection, Terminable, UUID, ValueAxis} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {AnyClipBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {NoteClipBox, NoteEventCollectionBox, TrackBox, ValueClipBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import type {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

// Issue 514, clip side: Ctrl copies, Ctrl+Shift mirrors, whatever the source's state.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const SourceIndex: int = 0
const TargetIndex: int = 1
const SiblingIndex: int = 5

type Kind = Readonly<{
    name: string
    trackType: TrackType
    populate: (graph: BoxGraph, trackBox: TrackBox, mirrored: boolean) => void
}>

const indices = (mirrored: boolean): ReadonlyArray<int> => mirrored ? [SourceIndex, SiblingIndex] : [SourceIndex]

const Kinds: ReadonlyArray<Kind> = [{
    name: "note", trackType: TrackType.Notes, populate: (graph, trackBox, mirrored) => {
        const events = NoteEventCollectionBox.create(graph, UUID.generate())
        indices(mirrored).forEach(index => NoteClipBox.create(graph, UUID.generate(), box => {
            box.index.setValue(index)
            box.duration.setValue(PPQN.Bar)
            box.clips.refer(trackBox.clips)
            box.events.refer(events.owners)
        }))
    }
}, {
    name: "value", trackType: TrackType.Value, populate: (graph, trackBox, mirrored) => {
        const events = ValueEventCollectionBox.create(graph, UUID.generate())
        indices(mirrored).forEach(index => ValueClipBox.create(graph, UUID.generate(), box => {
            box.index.setValue(index)
            box.duration.setValue(PPQN.Bar)
            box.clips.refer(trackBox.clips)
            box.events.refer(events.owners)
        }))
    }
}]

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createSelection = (): Selection<AnyClipBoxAdapter> => {
    const selected: Array<AnyClipBoxAdapter> = []
    const selection = {
        select: (...clips: Array<AnyClipBoxAdapter>) => clips.forEach(clip => {
            if (selected.includes(clip)) {return}
            selected.push(clip)
            clip.onSelected()
        }),
        deselect: (...clips: Array<AnyClipBoxAdapter>) => clips.forEach(clip => {
            const index = selected.indexOf(clip)
            if (index === -1) {return}
            selected.splice(index, 1)
            clip.onDeselected()
        }),
        deselectAll: () => selection.deselect(...selected.slice()),
        isSelected: (clip: AnyClipBoxAdapter) => selected.includes(clip),
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

const setup = async (kind: Kind, mirroredSource: boolean) => {
    const {Project} = await import("@opendaw/studio-core")
    const {ClipMoveModifier} = await import("./ClipMoveModifier.ts")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(kind.trackType)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    kind.populate(boxGraph, trackBox, mirroredSource)
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    const track = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    track.listIndex = 0
    const tracks = [{trackBoxAdapter: track}]
    const manager = {
        tracks: () => tracks,
        numTracks: () => tracks.length,
        maxClipsIndex: {getValue: () => 16},
        getByIndex: (index: int) => Option.wrap(tracks[index])
    } as unknown as TracksManager
    const clipAt = (index: int): AnyClipBoxAdapter => track.clips.collection.getAdapterByIndex(index).unwrap("clip")
    const selection = createSelection()
    selection.select(clipAt(SourceIndex))
    const axis: ValueAxis = {axisToValue: (axis: number) => axis, valueToAxis: (value: number) => value}
    const startDrag = (ctrlKey: boolean, shiftKey: boolean, targetIndex: int = TargetIndex) => {
        const modifier = ClipMoveModifier.start({
            project, manager, selection, xAxis: axis, yAxis: axis, pointerClipIndex: SourceIndex, pointerTrackIndex: 0
        }).unwrap("move")
        modifier.update({clientX: targetIndex, clientY: 0, altKey: false, ctrlKey, shiftKey})
        return modifier
    }
    return {clipAt, selection, startDrag}
}

describe("Ctrl copies and Ctrl+Shift mirrors clips, whatever the source's state (514)", () => {
    const Sources = [false, true]
    const Shifts = [false, true]
    Kinds.forEach(kind => describe(kind.name, () => {
        Sources.forEach(mirroredSource => Shifts.forEach(shift => {
            const label = `${mirroredSource ? "mirrored" : "independent"} source, ${shift ? "Ctrl+Shift" : "Ctrl"}`
            it(`${label} ${shift ? "shares" : "does not share"} the events`, async () => {
                const {clipAt, startDrag} = await setup(kind, mirroredSource)
                const events = clipAt(SourceIndex).optCollection.unwrap("source events")
                startDrag(true, shift).approve()
                const original = clipAt(SourceIndex)
                const copy = clipAt(TargetIndex)
                expect(copy).not.toBe(original)
                expect(copy.optCollection.unwrap("copy events") === events).toBe(shift)
                expect(copy.isMirrowed).toBe(shift)
                expect(original.optCollection.unwrap("original events")).toBe(events)
                expect(original.isMirrowed).toBe(shift || mirroredSource)
            })
            it(`${label} previews the result`, async () => {
                const {clipAt, startDrag} = await setup(kind, mirroredSource)
                const source = clipAt(SourceIndex)
                const modifier = startDrag(true, shift)
                expect(modifier.selectedModifyStrategy().readMirror(source)).toBe(shift)
                expect(modifier.unselectedModifyStrategy().readMirror(source)).toBe(shift || mirroredSource)
                modifier.cancel()
            })
            it(`a plain move of a ${mirroredSource ? "mirrored" : "independent"} clip keeps its state, shift ${shift}`, async () => {
                const {clipAt, startDrag} = await setup(kind, mirroredSource)
                const source = clipAt(SourceIndex)
                const events = source.optCollection.unwrap("source events")
                const modifier = startDrag(false, shift)
                expect(modifier.selectedModifyStrategy().readMirror(source)).toBe(mirroredSource)
                modifier.approve()
                expect(clipAt(TargetIndex)).toBe(source)
                expect(source.optCollection.unwrap("source events")).toBe(events)
                expect(source.isMirrowed).toBe(mirroredSource)
            })
        }))
    }))
    it("a second Ctrl+Shift copy from the original is linked to the first (the reported steps)", async () => {
        const {clipAt, selection, startDrag} = await setup(Kinds[0], false)
        const events = clipAt(SourceIndex).optCollection.unwrap("events")
        startDrag(true, true).approve()
        selection.deselectAll()
        selection.select(clipAt(SourceIndex))
        startDrag(true, true, TargetIndex + 1).approve()
        expect(clipAt(TargetIndex).optCollection.unwrap("first events")).toBe(events)
        expect(clipAt(TargetIndex + 1).optCollection.unwrap("second events")).toBe(events)
        expect(events.numOwners).toBe(3)
    })
})
