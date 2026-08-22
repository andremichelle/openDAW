import {describe, expect, it} from "vitest"
import {Address, BoxGraph} from "@opendaw/lib-box"
import {isDefined, Option, UUID} from "@opendaw/lib-std"
import {BoxIO, BoxVisitor, SelectionBox, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
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

// The `target` role from the field reports: a peer deleted the selected box while another peer still held a
// SelectionBox aimed at it. The merged document keeps the pointer, naming a uuid no box occupies.
describe("deterministicReconcile: dangling pointers", () => {
    const danglingSelection = (boxGraph: BoxGraph<BoxIO.TypeMap>): SelectionBox => {
        const box = SelectionBox.create(boxGraph, UUID.generate())
        box.selectable.targetAddress = Option.wrap(Address.compose(UUID.generate()))
        box.selection.targetAddress = Option.wrap(Address.compose(UUID.generate()))
        return box
    }

    it("drops a SelectionBox whose pointers no longer resolve", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        boxGraph.beginTransaction()
        const box = danglingSelection(boxGraph)
        boxGraph.endTransaction()

        expect(reconcile(boxGraph)).toBe(true)
        expect(boxGraph.findBox(box.address.uuid).isEmpty()).toBe(true)
    })

    it("reaches a fixpoint: every dangling owner goes in one pass", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        boxGraph.beginTransaction()
        const first = danglingSelection(boxGraph)
        const second = danglingSelection(boxGraph)
        boxGraph.endTransaction()

        expect(reconcile(boxGraph)).toBe(true)
        expect(boxGraph.findBox(first.address.uuid).isEmpty()).toBe(true)
        expect(boxGraph.findBox(second.address.uuid).isEmpty()).toBe(true)
    })

    it("is idempotent: a healed graph needs no further repair", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        boxGraph.beginTransaction()
        danglingSelection(boxGraph)
        boxGraph.endTransaction()

        reconcile(boxGraph)
        expect(reconcile(boxGraph)).toBe(false)
    })
})
