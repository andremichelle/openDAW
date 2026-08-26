import {describe, expect, it} from "vitest"
import {Address, BoxGraph} from "@opendaw/lib-box"
import {isDefined, Option, UUID} from "@opendaw/lib-std"
import {BoxIO, BoxVisitor, SelectionBox, ValueEventBox, ValueEventCollectionBox, ZeitgeistDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
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

const emptyProject = () => ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})

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
// SelectionBox aimed at it. The merged document keeps the pointer, naming a uuid no box occupies. Two generic
// rules handle it, neither naming a box type: clear an edge that does not resolve, then remove whoever is
// left holding a required pointer with nothing on the other end.
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

    it("clears the edge before deciding anything, so a FREE pointer only loses its edge", () => {
        const {boxGraph, mandatoryBoxes: {rootBox}} = emptyProject()
        boxGraph.beginTransaction()
        // `shadertoy` is free: nothing requires it, so the dead edge is dropped and the box lives.
        rootBox.shadertoy.targetAddress = Option.wrap(Address.compose(UUID.generate()))
        boxGraph.endTransaction()

        expect(reconcile(boxGraph)).toBe(true)
        expect(rootBox.isAttached(), "the RootBox survives").toBe(true)
        expect(rootBox.shadertoy.isEmpty()).toBe(true)
    })

    it("leaves a healthy project completely alone", () => {
        const {boxGraph} = emptyProject()
        const before = boxGraph.boxes().length

        expect(reconcile(boxGraph)).toBe(false)
        expect(boxGraph.boxes().length).toBe(before)
    })

    it("converges: two graphs holding the same corruption repair to the same result", () => {
        const build = (): BoxGraph<BoxIO.TypeMap> => {
            const boxGraph = new BoxGraph<BoxIO.TypeMap>()
            boxGraph.beginTransaction()
            const dead = Address.compose(UUID.generate())
            for (let index = 0; index < 4; index++) {
                const box = SelectionBox.create(boxGraph, UUID.generate())
                box.selectable.targetAddress = Option.wrap(dead)
                box.selection.targetAddress = Option.wrap(dead)
            }
            boxGraph.endTransaction()
            return boxGraph
        }
        const first = build()
        const second = build()
        reconcile(first)
        reconcile(second)
        expect(first.boxes().length).toBe(0)
        expect(second.boxes().length).toBe(0)
    })

    it("removes a box whose required target is gone, and nothing else", () => {
        const {boxGraph, mandatoryBoxes: {rootBox}} = emptyProject()
        boxGraph.beginTransaction()
        const groove = rootBox.groove.targetVertex.unwrap("groove")
        const zeitgeist = ZeitgeistDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.groove.refer(groove)
            box.host.targetAddress = Option.wrap(Address.compose(UUID.generate(), 1))
        })
        boxGraph.endTransaction()

        expect(reconcile(boxGraph)).toBe(true)
        expect(boxGraph.findBox(zeitgeist.address.uuid).isEmpty(), "no host, so it cannot exist").toBe(true)
        expect(rootBox.isAttached(), "the rest is untouched").toBe(true)
    })

})
