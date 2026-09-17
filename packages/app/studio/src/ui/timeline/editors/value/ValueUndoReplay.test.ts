import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID, ValueMapping} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {
    InstrumentFactories,
    ProjectSkeleton,
    TrackType,
    ValueEventBoxAdapter,
    ValueEventCollectionBoxAdapter
} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "@opendaw/studio-core"

// live id 1120: "collection" unwrap in ValueEventBoxAdapter.copyFrom during a value-editor drag, after bursts of
// undo each preceded by a delete-selection in the editor. Replays that shape with the editor's own code paths.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const fakeEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const setup = async () => {
    const {Project, TimelineRange} = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const {ValueEventEditing} = await import("@/ui/timeline/editors/value/ValueEventEditing.ts")
    const {ValueMoveModifier} = await import("@/ui/timeline/editors/value/ValueMoveModifier.ts")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(fakeEnv(), skeleton)
    const {editing, boxGraph, boxAdapters} = project
    const collectionBox = editing.modify(() => {
        const {audioUnitBox} = project.api.createInstrument(InstrumentFactories.Tape)
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox.volume)
            box.index.setValue(1)
        })
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(PPQN.Bar * 4)
        })
        return events
    }, false).unwrap()
    editing.mark()
    const collection = boxAdapters.adapterFor(collectionBox, ValueEventCollectionBoxAdapter)
    const eventsField = collectionBox.events
    const selection = project.selection.createFilteredSelection(box => box instanceof ValueEventBox
        && box.events.targetVertex.contains(eventsField), {
        fx: (adapter: ValueEventBoxAdapter) => adapter.box,
        fy: vertex => boxAdapters.adapterFor(vertex.box, ValueEventBoxAdapter)
    })
    const range = new TimelineRange({padding: 0})
    range.maxUnits = PPQN.fromSignature(64, 4)
    range.width = 4096
    range.showAll()
    const snapping = new Snapping(range)
    snapping.index = 3
    const eventMapping = ValueMapping.unipolar()
    const drag = (reference: ValueEventBoxAdapter, deltaPulse: number) => {
        const modifier = ValueMoveModifier.create({
            editing,
            element: {getBoundingClientRect: () => ({left: 0, top: 0})} as unknown as Element,
            context: {quantize: (value: number) => value, currentValue: 0.5, anchorModel: {getValue: () => 0}} as never,
            selection,
            valueAxis: {axisToValue: () => reference.value, valueToAxis: () => 0} as never,
            eventMapping,
            snapping,
            pointerPulse: reference.position,
            pointerValue: reference.value,
            reference,
            collection
        })
        modifier.update({
            clientX: range.unitToX(reference.position + deltaPulse), clientY: 0,
            altKey: false, ctrlKey: false, shiftKey: false
        } as never)
        modifier.approve()
    }
    const create = (position: number, value: number) =>
        editing.modify(() => ValueEventEditing.createOrMoveEvent(collection, position, value)).unwrap()
    const deleteSelected = () => editing.modify(() =>
        selection.selected().forEach(adapter => ValueEventEditing.deleteEvent(collection, adapter)))
    const zombies = () => collection.events.asArray()
        .filter(adapter => !adapter.box.isAttached() || adapter.collection.isEmpty())
    return {project, editing, collection, selection, create, deleteSelected, drag, zombies}
}

describe("value editor: delete, undo bursts, then drag (#1120)", () => {
    it("survives delete-selection followed by undos and a drag", async () => {
        const {editing, collection, selection, create, deleteSelected, drag, zombies} = await setup()
        const grid = PPQN.fromSignature(1, 4)
        const created = [0, 1, 2, 3, 4, 5].map(index => create(index * grid, 0.25 + index * 0.1))
        selection.select(created[1], created[2])
        deleteSelected()
        for (let step = 0; step < 3; step++) {editing.undo()}
        expect(zombies()).toEqual([])
        selection.select(...collection.events.asArray().slice(0, 2))
        deleteSelected()
        for (let step = 0; step < 4; step++) {editing.undo()}
        expect(zombies()).toEqual([])
        const remaining = collection.events.asArray()
        expect(remaining.length).toBeGreaterThan(0)
        selection.deselectAll()
        selection.select(...remaining)
        expect(() => drag(remaining[0], grid)).not.toThrow()
        expect(zombies()).toEqual([])
    })
    it("every undo depth after a delete leaves no zombie and a drag succeeds", async () => {
        const grid = PPQN.fromSignature(1, 4)
        for (let depth = 1; depth <= 8; depth++) {
            const {editing, collection, selection, create, deleteSelected, drag, zombies} = await setup()
            const created = [0, 1, 2, 3].map(index => create(index * grid, 0.5))
            selection.select(created[0], created[3])
            deleteSelected()
            selection.select(...collection.events.asArray())
            deleteSelected()
            for (let step = 0; step < depth; step++) {editing.undo()}
            expect(zombies(), `depth ${depth}`).toEqual([])
            const remaining = collection.events.asArray()
            if (remaining.length === 0) {continue}
            selection.deselectAll()
            selection.select(...remaining)
            expect(() => drag(remaining[0], grid), `depth ${depth}`).not.toThrow()
        }
    })
})
