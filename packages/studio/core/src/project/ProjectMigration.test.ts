import {describe, expect, it} from "vitest"
import {BoxGraph} from "@opendaw/lib-box"
import {isDefined, Option, UUID} from "@opendaw/lib-std"
import {BoxIO, BoxVisitor, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"

const createTestSetup = () => {
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    boxGraph.beginTransaction()
    const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    boxGraph.endTransaction()
    return {boxGraph, collection}
}

const createEvent = (boxGraph: BoxGraph<BoxIO.TypeMap>, collection: ValueEventCollectionBox,
                     position: number, index: number, value: number = 0.5) => {
    boxGraph.beginTransaction()
    const event = ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.position.setValue(position)
        box.index.setValue(index)
        box.value.setValue(value)
    })
    boxGraph.endTransaction()
    return event
}

const getEvents = (collection: ValueEventCollectionBox): Array<{ position: number, index: number, value: number }> => {
    return collection.events.pointerHub.incoming()
        .map(pointer => pointer.box.accept<BoxVisitor<ValueEventBox>>({
            visitValueEventBox: (box) => box
        }))
        .filter(isDefined)
        .sort((a, b) => {
            const positionDiff = a.position.getValue() - b.position.getValue()
            return positionDiff !== 0 ? positionDiff : a.index.getValue() - b.index.getValue()
        })
        .map(box => ({
            position: box.position.getValue(),
            index: box.index.getValue(),
            value: Math.round(box.value.getValue() * 100) / 100
        }))
}

const migrateValueEventCollection = (boxGraph: BoxGraph<BoxIO.TypeMap>, collectionBox: ValueEventCollectionBox) => {
    const events = collectionBox.events.pointerHub.incoming()
        .map(pointer => pointer.box.accept<BoxVisitor<ValueEventBox>>({
            visitValueEventBox: (eventBox) => eventBox
        }))
        .filter(isDefined)
        .sort((a, b) => {
            const positionDiff = a.position.getValue() - b.position.getValue()
            return positionDiff !== 0 ? positionDiff : a.index.getValue() - b.index.getValue()
        })
    if (events.length === 0) {return}
    const toDelete: Array<ValueEventBox> = []
    const toFix: Array<{ event: ValueEventBox, index: number }> = []
    let first: ValueEventBox = events[0]
    let last: ValueEventBox = events[0]
    let count = 1
    const flush = () => {
        if (count === 1) {
            if (first.index.getValue() !== 0) {toFix.push({event: first, index: 0})}
        } else {
            if (first.index.getValue() !== 0) {toFix.push({event: first, index: 0})}
            if (last.index.getValue() !== 1) {toFix.push({event: last, index: 1})}
        }
    }
    for (let i = 1; i < events.length; i++) {
        const event = events[i]
        if (event.position.getValue() === first.position.getValue()) {
            if (count >= 2) {toDelete.push(last)}
            last = event
            count++
        } else {
            flush()
            first = event
            last = event
            count = 1
        }
    }
    flush()
    if (toDelete.length > 0 || toFix.length > 0) {
        boxGraph.beginTransaction()
        toFix.forEach(({event, index}) => event.index.setValue(index))
        toDelete.forEach(event => event.delete())
        boxGraph.endTransaction()
    }
}

describe("ProjectMigration.visitValueEventCollectionBox", () => {
    describe("single event at position", () => {
        it("should keep single event with index 0 unchanged", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.5)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(1)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.5})
        })
        it("should fix single event with wrong index to 0", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 1, 0.7)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(1)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.7})
        })
    })
    describe("two events at same position", () => {
        it("should keep two events with correct indices unchanged", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 100, 1, 0.9)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(2)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.1})
            expect(events[1]).toEqual({position: 100, index: 1, value: 0.9})
        })
        it("should fix two events both with index 0", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.2)
            createEvent(boxGraph, collection, 100, 0, 0.8)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(2)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.2})
            expect(events[1]).toEqual({position: 100, index: 1, value: 0.8})
        })
        it("should fix two events both with index 1", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 1, 0.3)
            createEvent(boxGraph, collection, 100, 1, 0.7)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(2)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.3})
            expect(events[1]).toEqual({position: 100, index: 1, value: 0.7})
        })
    })
    describe("more than two events at same position", () => {
        it("should keep first and last, delete middle event", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 100, 1, 0.5)
            createEvent(boxGraph, collection, 100, 2, 0.9)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(2)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.1})
            expect(events[1]).toEqual({position: 100, index: 1, value: 0.9})
        })
        it("should delete multiple middle events", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 100, 1, 0.2)
            createEvent(boxGraph, collection, 100, 2, 0.3)
            createEvent(boxGraph, collection, 100, 3, 0.4)
            createEvent(boxGraph, collection, 100, 4, 0.5)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(2)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.1})
            expect(events[1]).toEqual({position: 100, index: 1, value: 0.5})
        })
        it("should handle three events all with index 0", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 100, 0, 0.5)
            createEvent(boxGraph, collection, 100, 0, 0.9)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(2)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.1})
            expect(events[1]).toEqual({position: 100, index: 1, value: 0.9})
        })
    })
    describe("multiple positions", () => {
        it("should handle events at different positions independently", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 200, 0, 0.5)
            createEvent(boxGraph, collection, 300, 0, 0.9)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(3)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.1})
            expect(events[1]).toEqual({position: 200, index: 0, value: 0.5})
            expect(events[2]).toEqual({position: 300, index: 0, value: 0.9})
        })
        it("should fix duplicates at multiple positions", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 100, 0, 0.2)
            createEvent(boxGraph, collection, 200, 0, 0.3)
            createEvent(boxGraph, collection, 200, 1, 0.4)
            createEvent(boxGraph, collection, 200, 2, 0.5)
            createEvent(boxGraph, collection, 300, 1, 0.6)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(5)
            expect(events[0]).toEqual({position: 100, index: 0, value: 0.1})
            expect(events[1]).toEqual({position: 100, index: 1, value: 0.2})
            expect(events[2]).toEqual({position: 200, index: 0, value: 0.3})
            expect(events[3]).toEqual({position: 200, index: 1, value: 0.5})
            expect(events[4]).toEqual({position: 300, index: 0, value: 0.6})
        })
    })
    describe("empty collection", () => {
        it("should handle empty collection without error", () => {
            const {boxGraph, collection} = createTestSetup()
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(0)
        })
    })
    describe("already valid collections", () => {
        it("should not modify valid collection with single events", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 200, 0, 0.5)
            createEvent(boxGraph, collection, 300, 0, 0.9)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(3)
            expect(events).toEqual([
                {position: 100, index: 0, value: 0.1},
                {position: 200, index: 0, value: 0.5},
                {position: 300, index: 0, value: 0.9}
            ])
        })
        it("should not modify valid collection with paired events", () => {
            const {boxGraph, collection} = createTestSetup()
            createEvent(boxGraph, collection, 100, 0, 0.1)
            createEvent(boxGraph, collection, 100, 1, 0.2)
            createEvent(boxGraph, collection, 200, 0, 0.3)
            createEvent(boxGraph, collection, 200, 1, 0.4)
            migrateValueEventCollection(boxGraph, collection)
            const events = getEvents(collection)
            expect(events).toHaveLength(4)
            expect(events).toEqual([
                {position: 100, index: 0, value: 0.1},
                {position: 100, index: 1, value: 0.2},
                {position: 200, index: 0, value: 0.3},
                {position: 200, index: 1, value: 0.4}
            ])
        })
    })
})
