import {describe, expect, it} from "vitest"
import {BoxGraph, Field} from "@opendaw/lib-box"
import {isDefined, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {
    BoxIO,
    BoxVisitor,
    DelayDeviceBox,
    TrackBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueEventCurveBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {migrateAutomation} from "./MigrateAutomation"

// Test kit: a DelayDeviceBox only serves as a box with several automatable parameters.
type Graph = BoxGraph<BoxIO.TypeMap>
type EventSpec = { position: number, value: number, index?: number, interpolation?: number, curve?: number }

const transact = <T>(graph: Graph, run: () => T): T => {
    graph.beginTransaction()
    const result = run()
    graph.endTransaction()
    return result
}
const createDevice = (graph: Graph) => transact(graph, () => DelayDeviceBox.create(graph, UUID.generate()))
const createTrack = (graph: Graph, target?: Field<Pointers.Automation>) =>
    transact(graph, () => TrackBox.create(graph, UUID.generate(), box => {if (isDefined(target)) {box.target.refer(target)}}))
const createCollection = (graph: Graph, events: ReadonlyArray<EventSpec>) => transact(graph, () => {
    const collection = ValueEventCollectionBox.create(graph, UUID.generate())
    events.forEach(spec => {
        const event = ValueEventBox.create(graph, UUID.generate(), box => {
            box.events.refer(collection.events)
            box.position.setValue(spec.position)
            box.index.setValue(spec.index ?? 0)
            box.interpolation.setValue(spec.interpolation ?? 0)
            box.value.setValue(spec.value)
        })
        if (isDefined(spec.curve)) {
            ValueEventCurveBox.create(graph, UUID.generate(), box => {
                box.event.refer(event.interpolation)
                box.slope.setValue(spec.curve!)
            })
        }
    })
    return collection
})
const addRegion = (graph: Graph, track: TrackBox, collection: ValueEventCollectionBox, position = 0) =>
    transact(graph, () => ValueRegionBox.create(graph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(collection.owners)
        box.position.setValue(position)
        box.duration.setValue(3840)
    }))
const addClip = (graph: Graph, track: TrackBox, collection: ValueEventCollectionBox) =>
    transact(graph, () => ValueClipBox.create(graph, UUID.generate(), box => {
        box.clips.refer(track.clips)
        box.events.refer(collection.owners)
        box.duration.setValue(3840)
    }))
const collectionOf = (owner: ValueRegionBox | ValueClipBox): ValueEventCollectionBox =>
    owner.events.targetVertex.unwrap("events").box.accept<BoxVisitor<ValueEventCollectionBox>>({
        visitValueEventCollectionBox: box => box
    })!
const snapshot = (collection: ValueEventCollectionBox) => collection.events.pointerHub.incoming()
    .map(pointer => pointer.box as ValueEventBox)
    .sort((left, right) => left.position.getValue() - right.position.getValue() || left.index.getValue() - right.index.getValue())
    .map(event => ({
        position: event.position.getValue(),
        index: event.index.getValue(),
        interpolation: event.interpolation.getValue(),
        value: event.value.getValue(),
        curve: event.interpolation.pointerHub.incoming()
            .map(pointer => (pointer.box as ValueEventCurveBox).slope.getValue()).at(0)
    }))
const values = (collection: ValueEventCollectionBox) => snapshot(collection).map(event => event.value)
const migrate = (graph: Graph, target: Field<Pointers.Automation>, map: (unit: number) => number) =>
    transact(graph, () => migrateAutomation(graph, target, map))
const double = (unit: number) => unit * 2
const countOf = (graph: Graph, name: string) => graph.boxes().filter(box => box.name === name).length

describe("migrateAutomation", () => {
    it("rewrites an unshared region in place", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.1}, {position: 960, value: 0.3}])
        const region = addRegion(graph, createTrack(graph, device.delayMusical), collection)
        migrate(graph, device.delayMusical, double)
        expect(collectionOf(region)).toBe(collection)
        expect(values(collection)).toEqual([Math.fround(0.2), Math.fround(0.6)])
        expect(countOf(graph, "ValueEventCollectionBox")).toBe(1)
    })
    it("does nothing and creates nothing without automation", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const before = graph.boxes().length
        migrate(graph, device.delayMusical, double)
        expect(graph.boxes().length).toBe(before)
    })
    it("ignores tracks of other parameters", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.25}])
        addRegion(graph, createTrack(graph, device.feedback), collection)
        migrate(graph, device.delayMusical, double)
        expect(values(collection)).toEqual([0.25])
    })
    it("copies a collection shared with a region automating another parameter", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [
            {position: 0, value: 0.1, interpolation: 1}, {position: 960, value: 0.2, index: 0}, {position: 960, value: 0.4, index: 1}])
        const original = snapshot(collection)
        const ours = addRegion(graph, createTrack(graph, device.delayMusical), collection)
        const theirs = addRegion(graph, createTrack(graph, device.feedback), collection)
        migrate(graph, device.delayMusical, double)
        expect(collectionOf(theirs)).toBe(collection)
        expect(snapshot(collection)).toEqual(original)
        const copy = collectionOf(ours)
        expect(copy).not.toBe(collection)
        expect(snapshot(copy)).toEqual(original.map(event => ({...event, value: Math.fround(event.value * 2)})))
        expect(countOf(graph, "ValueEventCollectionBox")).toBe(2)
        expect(countOf(graph, "ValueEventBox")).toBe(6)
    })
    it("copies a collection shared with a clip automating another parameter", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.3}])
        const ours = addRegion(graph, createTrack(graph, device.delayMusical), collection)
        const theirs = addClip(graph, createTrack(graph, device.wet), collection)
        migrate(graph, device.delayMusical, double)
        expect(values(collectionOf(theirs))).toEqual([Math.fround(0.3)])
        expect(values(collectionOf(ours))).toEqual([Math.fround(0.6)])
    })
    it("migrates clips on the automated track", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.125}])
        const clip = addClip(graph, createTrack(graph, device.delayMusical), collection)
        migrate(graph, device.delayMusical, double)
        expect(collectionOf(clip)).toBe(collection)
        expect(values(collection)).toEqual([0.25])
    })
    it("keeps regions of the same track sharing one collection, migrated once", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.125}])
        const track = createTrack(graph, device.delayMusical)
        const first = addRegion(graph, track, collection, 0)
        const second = addRegion(graph, track, collection, 3840)
        migrate(graph, device.delayMusical, double)
        expect(collectionOf(first)).toBe(collection)
        expect(collectionOf(second)).toBe(collection)
        expect(values(collection)).toEqual([0.25])
    })
    it("keeps a region and a clip of the target sharing one copy when a foreign owner exists", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.125}])
        const track = createTrack(graph, device.delayMusical)
        const region = addRegion(graph, track, collection)
        const clip = addClip(graph, track, collection)
        const foreign = addRegion(graph, createTrack(graph, device.dry), collection)
        migrate(graph, device.delayMusical, double)
        expect(collectionOf(region)).toBe(collectionOf(clip))
        expect(collectionOf(region)).not.toBe(collection)
        expect(collectionOf(foreign)).toBe(collection)
        expect(values(collectionOf(region))).toEqual([0.25])
        expect(values(collection)).toEqual([0.125])
    })
    it("treats an owner on a track without a target as foreign", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.125}])
        const ours = addRegion(graph, createTrack(graph, device.delayMusical), collection)
        const orphan = addRegion(graph, createTrack(graph), collection)
        migrate(graph, device.delayMusical, double)
        expect(values(collectionOf(orphan))).toEqual([0.125])
        expect(values(collectionOf(ours))).toEqual([0.25])
    })
    it("copies curves, interpolation and indices", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [
            {position: 0, value: 0.1, interpolation: 0, curve: 0.75},
            {position: 480, value: 0.2, interpolation: 1},
            {position: 960, value: 0.3, interpolation: 0}])
        const ours = addRegion(graph, createTrack(graph, device.delayMusical), collection)
        addRegion(graph, createTrack(graph, device.cross), collection)
        migrate(graph, device.delayMusical, unit => unit)
        expect(snapshot(collectionOf(ours))).toEqual(snapshot(collection))
        expect(snapshot(collectionOf(ours))[0].curve).toBe(0.75)
        expect(countOf(graph, "ValueEventCurveBox")).toBe(2)
    })
    it("migrates each of two devices sharing one collection exactly once", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const left = createDevice(graph)
        const right = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.125}, {position: 960, value: 0.25}])
        const regionLeft = addRegion(graph, createTrack(graph, left.delayMusical), collection)
        const regionRight = addRegion(graph, createTrack(graph, right.delayMusical), collection)
        migrate(graph, left.delayMusical, double)
        migrate(graph, right.delayMusical, double)
        expect(values(collectionOf(regionLeft))).toEqual([0.25, 0.5])
        expect(values(collectionOf(regionRight))).toEqual([0.25, 0.5])
    })
    it("ignores non-track pointers on the parameter", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const device = createDevice(graph)
        const collection = createCollection(graph, [{position: 0, value: 0.125}])
        const region = addRegion(graph, createTrack(graph, device.delayMusical), collection)
        const lone = createCollection(graph, [{position: 0, value: 0.5}])
        migrate(graph, device.delayMusical, double)
        expect(values(collectionOf(region))).toEqual([0.25])
        expect(values(lone)).toEqual([0.5])
    })
})
