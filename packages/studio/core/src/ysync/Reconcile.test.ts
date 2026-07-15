import {describe, expect, it} from "vitest"
import {BoxGraph} from "@opendaw/lib-box"
import {isDefined, UUID} from "@opendaw/lib-std"
import {BoxIO, BoxVisitor, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {deterministicReconcile} from "./Reconcile"

// Live error 1047: a collaborative merge produced two ValueEventBoxes at the same (position, index), which the
// SortedSet comparator rejects lazily in asArray (on selection). deterministicReconcile must heal the collection
// onto (position, index) uniqueness at merge time so every client converges without the later crash.

const createCollection = () => {
    const boxGraph = new BoxGraph<BoxIO.TypeMap>()
    boxGraph.beginTransaction()
    const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    boxGraph.endTransaction()
    return {boxGraph, collection}
}

const addEvent = (boxGraph: BoxGraph<BoxIO.TypeMap>, collection: ValueEventCollectionBox,
                  position: number, index: number) => {
    boxGraph.beginTransaction()
    ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.position.setValue(position)
        box.index.setValue(index)
        box.value.setValue(0.5)
    })
    boxGraph.endTransaction()
}

const keys = (collection: ValueEventCollectionBox): Array<{position: number, index: number}> =>
    collection.events.pointerHub.incoming()
        .map(pointer => pointer.box.accept<BoxVisitor<ValueEventBox>>({visitValueEventBox: (box) => box}))
        .filter(isDefined)
        .map(box => ({position: box.position.getValue(), index: box.index.getValue()}))
        .sort((a, b) => a.position - b.position || a.index - b.index)

const reconcile = (boxGraph: BoxGraph<BoxIO.TypeMap>): boolean => {
    boxGraph.beginTransaction()
    const repaired = deterministicReconcile(boxGraph)
    boxGraph.endTransaction()
    return repaired
}

describe("deterministicReconcile: duplicate value events (1047)", () => {
    it("splits two events colliding at (position, 0) into indices 0 and 1", () => {
        const {boxGraph, collection} = createCollection()
        addEvent(boxGraph, collection, 15360, 0)
        addEvent(boxGraph, collection, 15360, 0)
        expect(reconcile(boxGraph)).toBe(true)
        expect(keys(collection)).toEqual([{position: 15360, index: 0}, {position: 15360, index: 1}])
    })

    it("is idempotent: a healed collection needs no further repair", () => {
        const {boxGraph, collection} = createCollection()
        addEvent(boxGraph, collection, 15360, 0)
        addEvent(boxGraph, collection, 15360, 0)
        reconcile(boxGraph)
        expect(reconcile(boxGraph)).toBe(false)
        expect(keys(collection)).toEqual([{position: 15360, index: 0}, {position: 15360, index: 1}])
    })

    it("leaves a valid collection untouched", () => {
        const {boxGraph, collection} = createCollection()
        addEvent(boxGraph, collection, 100, 0)
        addEvent(boxGraph, collection, 200, 0)
        expect(reconcile(boxGraph)).toBe(false)
        expect(keys(collection)).toEqual([{position: 100, index: 0}, {position: 200, index: 0}])
    })

    it("caps a position at two events, deleting the surplus (first@0, last@1)", () => {
        const {boxGraph, collection} = createCollection()
        addEvent(boxGraph, collection, 15360, 0)
        addEvent(boxGraph, collection, 15360, 0)
        addEvent(boxGraph, collection, 15360, 0)
        expect(reconcile(boxGraph)).toBe(true)
        expect(keys(collection)).toEqual([{position: 15360, index: 0}, {position: 15360, index: 1}])
    })
})
