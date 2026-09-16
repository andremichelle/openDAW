import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, ProjectSkeleton, TrackType, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../../project/ProjectEnv"

// live id 1120: after many undos in the value editor a move's reused event adapter had no collection.
// Replays the editor's own sequences (create, move with manual collection add/remove, delete, undo, redo)
// and checks the collection adapter never keeps an adapter whose box is gone.

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
    if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
    const {Project} = await import("../../project/Project")
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
            box.duration.setValue(3840)
        })
        return events
    }, false).unwrap()
    editing.mark()
    const collection = boxAdapters.adapterFor(collectionBox, ValueEventCollectionBoxAdapter)
    return {project, editing, collection}
}

const zombies = (collection: ValueEventCollectionBoxAdapter) =>
    collection.events.asArray().filter(adapter => !adapter.box.isAttached() || adapter.collection.isEmpty())

describe("value collection after undo", () => {
    it("create, undo, redo", async () => {
        const {editing, collection} = await setup()
        for (let index = 0; index < 4; index++) {
            editing.modify(() => collection.createEvent({position: index * 480, index: 0, value: 0.5, interpolation: Interpolation.Linear}))
        }
        expect(collection.events.asArray().length).toBe(4)
        for (let index = 0; index < 4; index++) {editing.undo()}
        expect(collection.events.asArray().length).toBe(0)
        for (let index = 0; index < 4; index++) {editing.redo()}
        expect(collection.events.asArray().length).toBe(4)
        expect(zombies(collection)).toEqual([])
    })
    it("move like the modifier (manual remove, copyFrom, add, delete obsolete), undo, redo", async () => {
        const {editing, collection} = await setup()
        const events = editing.modify(() => [0, 480, 960].map(position =>
            collection.createEvent({position, index: 0, value: 0.5, interpolation: Interpolation.Linear}))).unwrap()
        editing.modify(() => {
            const [first, second, third] = events
            collection.events.remove(first)
            collection.events.remove(second)
            first.copyFrom({position: 240})
            second.copyFrom({position: 720})
            collection.events.add(first)
            collection.events.add(second)
            third.box.delete()
        })
        expect(zombies(collection)).toEqual([])
        editing.undo()
        expect(collection.events.asArray().length).toBe(3)
        expect(zombies(collection)).toEqual([])
        editing.redo()
        expect(zombies(collection)).toEqual([])
        editing.undo()
        editing.undo()
        expect(collection.events.asArray().length).toBe(0)
        expect(zombies(collection)).toEqual([])
    })
    it("delete with successor promotion, undo", async () => {
        const {editing, collection} = await setup()
        editing.modify(() => {
            collection.createEvent({position: 480, index: 0, value: 0.2, interpolation: Interpolation.Linear})
            collection.createEvent({position: 480, index: 1, value: 0.8, interpolation: Interpolation.Linear})
        })
        const [incoming, outgoing] = collection.events.asArray()
        editing.modify(() => {
            collection.events.remove(incoming)
            incoming.box.delete()
            outgoing.box.index.setValue(0)
        })
        expect(zombies(collection)).toEqual([])
        editing.undo()
        expect(collection.events.asArray().length).toBe(2)
        expect(zombies(collection)).toEqual([])
        editing.undo()
        expect(collection.events.asArray().length).toBe(0)
        expect(zombies(collection)).toEqual([])
    })
    // KNOWN DEFECT, unlinked to a live id: a box deleted and re-created under the same uuid inside ONE transaction
    // never reaches the collection adapter. `BoxGraph.#finalizeTransaction` fires the pointer-hub notifications
    // only when a pointer's initial and final address differ, and the re-created box's pointer shares the address.
    it.fails("delete and re-create the same event in one modification, then undo", async () => {
        const {editing, collection, project} = await setup()
        const created = editing.modify(() => collection.createEvent({position: 480, index: 0, value: 0.5, interpolation: Interpolation.Linear})).unwrap()
        const uuid = created.uuid
        editing.modify(() => {
            created.box.delete()
            ValueEventBox.create(project.boxGraph, uuid, box => {
                box.position.setValue(960)
                box.index.setValue(0)
                box.value.setValue(0.5)
                box.events.refer(collection.box.events)
            })
        })
        expect(zombies(collection)).toEqual([])
        expect(collection.events.asArray().map(adapter => adapter.position)).toEqual([960])
        editing.undo()
        expect(zombies(collection)).toEqual([])
        expect(collection.events.asArray().map(adapter => adapter.position)).toEqual([480])
    })
})
