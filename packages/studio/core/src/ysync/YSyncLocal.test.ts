import {beforeEach, describe, expect, it, vi} from "vitest"
import * as Y from "yjs"
import {Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {Box, BoxConstruct, BoxGraph, Int32Field, NoPointers, PointerField, UnreferenceableType, VertexVisitor} from "@opendaw/lib-box"
import {LocalLayer, YSync} from "./YSync"

enum Pointer {Target}

class LeafBox extends Box<Pointer.Target, { 1: Int32Field }> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<LeafBox>): LeafBox {
        return graph.stageBox(new LeafBox({
            uuid, graph, name: "LeafBox",
            pointerRules: {accepts: [Pointer.Target], mandatory: false, exclusive: false}
        }), constructor)
    }
    private constructor(construct: BoxConstruct<Pointer.Target>) {super(construct)}
    protected initializeFields() {
        return {1: Int32Field.create({parent: this, fieldKey: 1, fieldName: "index", deprecated: false, pointerRules: NoPointers}, "any", "none")}
    }
    accept<R>(visitor: VertexVisitor<R>): Maybe<R> {return safeExecute(undefined, this as never)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get index(): Int32Field {return this.getField(1)}
}

// Mandatory: a local RefBox cannot survive when a peer deletes its target.
class RefBox extends Box<UnreferenceableType, { 1: PointerField<Pointer.Target>, 2: PointerField<Pointer.Target> }> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<RefBox>): RefBox {
        return graph.stageBox(new RefBox({uuid, graph, name: "RefBox", pointerRules: NoPointers}), constructor)
    }
    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}
    protected initializeFields() {
        return {
            1: PointerField.create({parent: this, fieldKey: 1, fieldName: "target", deprecated: false, pointerRules: NoPointers}, Pointer.Target, true),
            2: PointerField.create({parent: this, fieldKey: 2, fieldName: "optional", deprecated: false, pointerRules: NoPointers}, Pointer.Target, false)
        }
    }
    accept<R>(visitor: VertexVisitor<R>): Maybe<R> {return safeExecute(undefined, this as never)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get target(): PointerField<Pointer.Target> {return this.getField(1)}
    get optional(): PointerField<Pointer.Target> {return this.getField(2)}
}

const factory = (name: string, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>): Box => {
    switch (name) {
        case "LeafBox": return LeafBox.create(graph, uuid, constructor as Procedure<LeafBox>)
        case "RefBox": return RefBox.create(graph, uuid, constructor as Procedure<RefBox>)
        default: return panic(`Unknown box: ${name}`)
    }
}

interface Peer {doc: Y.Doc, boxes: Y.Map<unknown>, graph: BoxGraph, sync: YSync<any>, layer: LocalLayer}

const edit = (peer: Peer, fn: (graph: BoxGraph) => void): void => {
    peer.graph.beginTransaction()
    fn(peer.graph)
    peer.graph.endTransaction()
}
const local = (peer: Peer, fn: (graph: BoxGraph) => void): void => peer.layer.run(() => edit(peer, fn))
const deliver = (from: Peer, to: Peer): void =>
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), from)
const converge = (a: Peer, b: Peer): void => {
    for (let round = 0; round < 4; round++) {
        deliver(a, b)
        deliver(b, a)
    }
}
const leaf = (peer: Peer, uuid: UUID.Bytes): LeafBox => peer.graph.findBox<LeafBox>(uuid).unwrap("no leaf")
const hex = (graph: BoxGraph): string => Array.from(graph.checksum(), byte => (byte & 0xff).toString(16).padStart(2, "0")).join("")
const expectConverged = (a: Peer, b: Peer): void => {
    converge(a, b)
    expect(hex(a.graph)).toBe(hex(b.graph))
    expect(a.graph.boxes().length).toBe(a.boxes.size)
}

describe("YSync local edits", () => {
    let A: Peer
    let B: Peer
    const u0 = UUID.generate()
    const u1 = UUID.generate()

    const makePeer = async (): Promise<Peer> => {
        const doc = new Y.Doc()
        const boxes = doc.getMap("boxes")
        const graph = new BoxGraph<any>(Option.wrap(factory as any))
        const sync = await YSync.populateRoom<any>({boxGraph: graph, boxes})
        return {doc, boxes, graph, sync, layer: sync.createLayer("preview")}
    }

    beforeEach(async () => {
        vi.spyOn(console, "debug").mockImplementation(() => {})
        A = await makePeer()
        B = await makePeer()
        edit(A, graph => {
            LeafBox.create(graph, u0, box => box.index.setValue(0))
            LeafBox.create(graph, u1, box => box.index.setValue(1))
        })
        converge(A, B)
    })

    it("sends nothing to the room", () => {
        const before = Y.encodeStateVector(A.doc)
        local(A, graph => {
            leaf(A, u1).index.setValue(2)
            LeafBox.create(graph, UUID.generate(), box => box.index.setValue(1))
        })
        expect(Y.encodeStateVector(A.doc)).toEqual(before)
        expect(A.graph.boxes().length).toBe(3)
        expect(B.graph.boxes().length).toBe(2)
    })

    it("revert returns to the document", () => {
        const checksum = hex(A.graph)
        local(A, graph => {
            leaf(A, u1).index.setValue(5)
            leaf(A, u0).delete()
            LeafBox.create(graph, UUID.generate())
        })
        A.layer.revert()
        expect(hex(A.graph)).toBe(checksum)
        expect(A.layer.hasChanges).toBe(false)
        expectConverged(A, B)
    })

    it("revert takes a peer's newer value, not the one before the preview", () => {
        local(A, () => leaf(A, u1).index.setValue(2))
        edit(B, () => leaf(B, u1).index.setValue(7))
        deliver(B, A)
        A.layer.revert()
        expect(leaf(A, u1).index.getValue()).toBe(7)
        expectConverged(A, B)
    })

    it("revert survives a peer deleting a box the preview shifted", () => {
        local(A, () => leaf(A, u1).index.setValue(2))
        edit(B, () => leaf(B, u1).delete())
        deliver(B, A)
        A.layer.revert()
        expect(A.graph.findBox(u1).isEmpty()).toBe(true)
        expectConverged(A, B)
    })

    it("a peer's unrelated edit applies and keeps the preview", () => {
        const invalid = vi.fn()
        A.layer.subscribeInvalid(invalid)
        const preview = UUID.generate()
        local(A, graph => LeafBox.create(graph, preview))
        edit(B, () => leaf(B, u0).index.setValue(9))
        deliver(B, A)
        expect(leaf(A, u0).index.getValue()).toBe(9)
        expect(A.graph.findBox(preview).nonEmpty()).toBe(true)
        expect(invalid).not.toHaveBeenCalled()
    })

    it("edits outside the scope still publish", () => {
        local(A, graph => LeafBox.create(graph, UUID.generate()))
        edit(A, () => leaf(A, u0).index.setValue(3))
        deliver(A, B)
        expect(leaf(B, u0).index.getValue()).toBe(3)
    })

    it("edits outside the scope that depend on a local box stay local", () => {
        const preview = UUID.generate()
        const ref = UUID.generate()
        const owner = UUID.generate()
        edit(A, graph => RefBox.create(graph, owner, box => box.target.refer(leaf(A, u0))))
        converge(A, B)
        local(A, graph => LeafBox.create(graph, preview))
        edit(A, graph => {
            RefBox.create(graph, ref, box => box.target.refer(leaf(A, preview)))
            A.graph.findBox<RefBox>(owner).unwrap().optional.refer(leaf(A, preview))
        })
        edit(A, () => leaf(A, preview).index.setValue(4))
        deliver(A, B)
        expect(B.graph.findBox(ref).isEmpty()).toBe(true)
        expect(B.graph.findBox<RefBox>(owner).unwrap().optional.isEmpty()).toBe(true)
        A.layer.revert()
        expect(A.graph.findBox(ref).isEmpty()).toBe(true)
        expect(A.graph.findBox<RefBox>(owner).unwrap().optional.isEmpty()).toBe(true)
        expectConverged(A, B)
    })

    it("a peer deleting what the preview depends on invalidates it", () => {
        const invalid = vi.fn()
        A.layer.subscribeInvalid(invalid)
        local(A, graph => RefBox.create(graph, UUID.generate(), box => box.target.refer(leaf(A, u0))))
        edit(B, () => leaf(B, u0).delete())
        deliver(B, A)
        expect(invalid).toHaveBeenCalledTimes(1)
        expect(A.layer.hasChanges).toBe(false)
        expect(A.graph.findBox(u0).isEmpty()).toBe(true)
        expectConverged(A, B)
    })

    it("a peer editing a box the preview replaced invalidates it", () => {
        const invalid = vi.fn()
        A.layer.subscribeInvalid(invalid)
        local(A, () => leaf(A, u0).delete())
        edit(B, () => leaf(B, u0).index.setValue(8))
        deliver(B, A)
        expect(invalid).toHaveBeenCalledTimes(1)
        expect(leaf(A, u0).index.getValue()).toBe(8)
        expectConverged(A, B)
    })

    it("a repair after invalidation never publishes preview boxes", () => {
        const preview = UUID.generate()
        local(A, graph => {
            LeafBox.create(graph, preview)
            RefBox.create(graph, UUID.generate(), box => box.target.refer(leaf(A, u0)))
        })
        edit(B, () => leaf(B, u0).delete())
        deliver(B, A)
        expect(A.boxes.has(UUID.toString(preview))).toBe(false)
        expect(A.graph.findBox(preview).isEmpty()).toBe(true)
        expectConverged(A, B)
    })

    it("a box both peers create keeps the room's copy on revert", () => {
        const shared = UUID.generate()
        local(A, graph => LeafBox.create(graph, shared, box => box.index.setValue(1)))
        edit(B, graph => LeafBox.create(graph, shared, box => box.index.setValue(6)))
        deliver(B, A)
        A.layer.revert()
        expect(leaf(A, shared).index.getValue()).toBe(6)
        expectConverged(A, B)
    })

    it("apply after revert sends one edit with an index from the current room", () => {
        for (let pick = 0; pick < 20; pick++) {
            A.layer.revert()
            local(A, graph => LeafBox.create(graph, UUID.generate(), box => box.index.setValue(2)))
        }
        expect(A.boxes.size).toBe(2)
        edit(B, graph => LeafBox.create(graph, UUID.generate(), box => box.index.setValue(2)))
        deliver(B, A)
        A.layer.revert()
        const applied = UUID.generate()
        edit(A, graph => LeafBox.create(graph, applied, box => box.index.setValue(A.graph.boxes().length)))
        expect(A.boxes.size).toBe(4)
        expectConverged(A, B)
        expect(leaf(B, applied).index.getValue()).toBe(3)
    })
})
