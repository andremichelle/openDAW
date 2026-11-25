import {describe, expect, it} from "vitest"
import {int, isDefined, Option, Selection, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {AnyRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {
    AudioFileBox, AudioRegionBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {BoxGraph} from "@opendaw/lib-box"
import type {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

// Issue 514: Ctrl copies, Ctrl+Shift mirrors, whatever the source's state. The copy used to compare the source's
// mirror state with Shift, so a source that already shared its events got the opposite of what was asked for.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const SourcePosition: ppqn = 0
const SiblingPosition: ppqn = PPQN.Bar * 16
const Delta: ppqn = PPQN.Bar * 4

// Builds the source, and with `mirrored` a sibling further down the track sharing the source's events.
type Kind = Readonly<{
    name: string
    trackType: TrackType
    populate: (graph: BoxGraph, trackBox: TrackBox, mirrored: boolean) => void
}>

const positions = (mirrored: boolean): ReadonlyArray<ppqn> =>
    mirrored ? [SourcePosition, SiblingPosition] : [SourcePosition]

const Kinds: ReadonlyArray<Kind> = [{
    name: "note", trackType: TrackType.Notes, populate: (graph, trackBox, mirrored) => {
        const events = NoteEventCollectionBox.create(graph, UUID.generate())
        positions(mirrored).forEach(position => NoteRegionBox.create(graph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(PPQN.Bar)
            box.loopDuration.setValue(PPQN.Bar)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        }))
    }
}, {
    name: "value", trackType: TrackType.Value, populate: (graph, trackBox, mirrored) => {
        const events = ValueEventCollectionBox.create(graph, UUID.generate())
        positions(mirrored).forEach(position => ValueRegionBox.create(graph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(PPQN.Bar)
            box.loopDuration.setValue(PPQN.Bar)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        }))
    }
}, {
    name: "audio", trackType: TrackType.Audio, populate: (graph, trackBox, mirrored) => {
        const events = ValueEventCollectionBox.create(graph, UUID.generate())
        const file = AudioFileBox.create(graph, UUID.generate(), box => box.endInSeconds.setValue(60))
        positions(mirrored).forEach(position => AudioRegionBox.create(graph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(PPQN.Bar)
            box.loopDuration.setValue(PPQN.Bar)
            box.regions.refer(trackBox.regions)
            box.file.refer(file)
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

const createSelection = (): Selection<AnyRegionBoxAdapter> => {
    const selected: Array<AnyRegionBoxAdapter> = []
    const selection = {
        select: (...regions: Array<AnyRegionBoxAdapter>) => regions.forEach(region => {
            if (selected.includes(region)) {return}
            selected.push(region)
            region.onSelected()
        }),
        deselect: (...regions: Array<AnyRegionBoxAdapter>) => regions.forEach(region => {
            const index = selected.indexOf(region)
            if (index === -1) {return}
            selected.splice(index, 1)
            region.onDeselected()
        }),
        deselectAll: () => selection.deselect(...selected.slice()),
        isSelected: (region: AnyRegionBoxAdapter) => selected.includes(region),
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
    const {Project, TimelineRange} = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const {RegionMoveModifier} = await import("./RegionMoveModifier.ts")
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
    const manager = {
        service: {project},
        numTracks: () => 1,
        globalToIndex: (clientY: number) => clientY,
        getByIndex: (index: int) => Option.wrap([track][index]).map(trackBoxAdapter => ({trackBoxAdapter}))
    } as unknown as TracksManager
    const source = track.regions.collection.asArray()
        .find(region => region.position === SourcePosition) as AnyRegionBoxAdapter
    const selection = createSelection()
    selection.select(source)
    const range = new TimelineRange({padding: 0})
    range.maxUnits = PPQN.fromSignature(64, 4)
    range.width = 65536
    range.showAll()
    const snapping = new Snapping(range)
    const element = {getBoundingClientRect: () => ({left: 0})} as unknown as Element
    const startDrag = (ctrlKey: boolean, shiftKey: boolean, delta: ppqn = Delta) => {
        const modifier = RegionMoveModifier.create(manager, selection, {
            element, snapping, pointerPulse: SourcePosition, pointerIndex: 0, reference: source
        }).unwrap("move")
        modifier.update({clientX: range.unitToX(SourcePosition + delta), clientY: 0, altKey: false, ctrlKey, shiftKey})
        return modifier
    }
    return {source, selection, startDrag}
}

describe("Ctrl copies and Ctrl+Shift mirrors, whatever the source's state (514)", () => {
    const Sources = [false, true]
    const Shifts = [false, true]
    Kinds.forEach(kind => describe(kind.name, () => {
        Sources.forEach(mirroredSource => Shifts.forEach(shift => {
            const label = `${mirroredSource ? "mirrored" : "independent"} source, ${shift ? "Ctrl+Shift" : "Ctrl"}`
            it(`${label} ${shift ? "shares" : "does not share"} the events`, async () => {
                const {source, selection, startDrag} = await setup(kind, mirroredSource)
                const before = source.optCollection.unwrap("source events")
                startDrag(true, shift).approve()
                const [copy] = selection.selected()
                expect(copy).not.toBe(source)
                expect(copy.position).toBe(SourcePosition + Delta)
                expect(copy.optCollection.unwrap("copy events") === before).toBe(shift)
                expect(copy.isMirrowed).toBe(shift)
                expect(source.optCollection.unwrap("source events")).toBe(before)
                expect(source.isMirrowed).toBe(shift || mirroredSource)
            })
            it(`${label} previews the result`, async () => {
                const {source, startDrag} = await setup(kind, mirroredSource)
                const modifier = startDrag(true, shift)
                expect(modifier.selectedModifyStrategy().readMirror(source)).toBe(shift)
                expect(modifier.unselectedModifyStrategy().readMirror(source)).toBe(shift || mirroredSource)
                modifier.cancel()
            })
        }))
        Sources.forEach(mirroredSource => Shifts.forEach(shift => {
            it(`a plain move of a ${mirroredSource ? "mirrored" : "independent"} region keeps its state, shift ${shift}`, async () => {
                const {source, selection, startDrag} = await setup(kind, mirroredSource)
                const before = source.optCollection.unwrap("source events")
                const modifier = startDrag(false, shift)
                expect(modifier.selectedModifyStrategy().readMirror(source)).toBe(mirroredSource)
                modifier.approve()
                expect(selection.selected()).toEqual([source])
                expect(source.position).toBe(SourcePosition + Delta)
                expect(source.optCollection.unwrap("source events")).toBe(before)
                expect(source.isMirrowed).toBe(mirroredSource)
            })
        }))
    }))
    it("a second Ctrl+Shift copy from the original is linked to the first (the reported steps)", async () => {
        const {source, selection, startDrag} = await setup(Kinds[0], false)
        const events = source.optCollection.unwrap("events")
        startDrag(true, true).approve()
        const [first] = selection.selected()
        selection.deselectAll()
        selection.select(source)
        startDrag(true, true, Delta * 2).approve()
        const [second] = selection.selected()
        expect(second).not.toBe(first)
        expect(first.optCollection.unwrap("first events")).toBe(events)
        expect(second.optCollection.unwrap("second events")).toBe(events)
        expect(events.numOwners).toBe(3)
    })
})
