import {beforeEach, describe, expect, it, vi} from "vitest"
import * as Y from "yjs"
import {Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {
    Box,
    BoxConstruct,
    BoxGraph,
    BooleanField,
    Int32Field,
    NoPointers,
    PointerField,
    StringField,
    UnreferenceableType,
    VertexVisitor
} from "@opendaw/lib-box"
import {YSync} from "./YSync"

// --- Minimal box fixtures (mirrors YSync.test.ts) ------------------------

enum Pointer {Target}

interface TestVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitLeafBox?(box: LeafBox): RETURN
    visitRefBox?(box: RefBox): RETURN
}

type LeafBoxFields = { 1: Int32Field, 2: StringField, 3: BooleanField }

class LeafBox extends Box<Pointer.Target, LeafBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<LeafBox>): LeafBox {
        return graph.stageBox(new LeafBox({
            uuid, graph, name: "LeafBox",
            pointerRules: {accepts: [Pointer.Target], mandatory: false, exclusive: false}
        }), constructor)
    }
    private constructor(construct: BoxConstruct<Pointer.Target>) {super(construct)}
    protected initializeFields(): LeafBoxFields {
        return {
            1: Int32Field.create({parent: this, fieldKey: 1, fieldName: "count", deprecated: false, pointerRules: NoPointers}, "any", "none"),
            2: StringField.create({parent: this, fieldKey: 2, fieldName: "label", deprecated: false, pointerRules: NoPointers}),
            3: BooleanField.create({parent: this, fieldKey: 3, fieldName: "flag", deprecated: false, pointerRules: NoPointers}, false)
        }
    }
    accept<R>(visitor: TestVisitor<R>): Maybe<R> {return safeExecute(visitor.visitLeafBox, this)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get count(): Int32Field {return this.getField(1)}
    get label(): StringField {return this.getField(2)}
    get flag(): BooleanField {return this.getField(3)}
}

type RefBoxFields = { 1: PointerField<Pointer.Target> }

class RefBox extends Box<UnreferenceableType, RefBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<RefBox>): RefBox {
        return graph.stageBox(new RefBox({uuid, graph, name: "RefBox", pointerRules: NoPointers}), constructor)
    }
    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}
    protected initializeFields(): RefBoxFields {
        return {
            1: PointerField.create({parent: this, fieldKey: 1, fieldName: "target", deprecated: false, pointerRules: NoPointers}, Pointer.Target, false)
        }
    }
    accept<R>(visitor: TestVisitor<R>): Maybe<R> {return safeExecute(visitor.visitRefBox, this)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get target(): PointerField<Pointer.Target> {return this.getField(1)}
}

// A target vertex that accepts at most ONE incoming pointer (exclusive). Concurrent edits that each
// attach a pointer are individually valid but jointly violate the rule once merged.
class ExclusiveBox extends Box<Pointer.Target, LeafBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<ExclusiveBox>): ExclusiveBox {
        return graph.stageBox(new ExclusiveBox({
            uuid, graph, name: "ExclusiveBox",
            pointerRules: {accepts: [Pointer.Target], mandatory: false, exclusive: true}
        }), constructor)
    }
    private constructor(construct: BoxConstruct<Pointer.Target>) {super(construct)}
    protected initializeFields(): LeafBoxFields {
        return {
            1: Int32Field.create({parent: this, fieldKey: 1, fieldName: "count", deprecated: false, pointerRules: NoPointers}, "any", "none"),
            2: StringField.create({parent: this, fieldKey: 2, fieldName: "label", deprecated: false, pointerRules: NoPointers}),
            3: BooleanField.create({parent: this, fieldKey: 3, fieldName: "flag", deprecated: false, pointerRules: NoPointers}, false)
        }
    }
    accept<R>(visitor: TestVisitor<R>): Maybe<R> {return safeExecute((visitor as any).visitExclusiveBox, this)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
}

const factory = (name: string, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>): Box => {
    switch (name) {
        case "LeafBox": return LeafBox.create(graph, uuid, constructor as Procedure<LeafBox>)
        case "RefBox": return RefBox.create(graph, uuid, constructor as Procedure<RefBox>)
        case "ExclusiveBox": return ExclusiveBox.create(graph, uuid, constructor as Procedure<ExclusiveBox>)
        default: return panic(`Unknown box: ${name}`)
    }
}

// --- Peer + network harness ----------------------------------------------

interface Peer {
    name: string
    doc: Y.Doc
    boxes: Y.Map<unknown>
    graph: BoxGraph
    sync: YSync<any>
}

const edit = (peer: Peer, fn: (graph: BoxGraph) => void): void => {
    peer.graph.beginTransaction()
    try {fn(peer.graph)} finally {peer.graph.endTransaction()}
}

// Deliver only the ops `to` is missing, with a non-string origin so `to`'s YSync treats them as a
// genuine remote batch (not own-origin, not local) and applies them to `to.graph`.
const deliver = (from: Peer, to: Peer): void => {
    const delta = Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc))
    Y.applyUpdate(to.doc, delta, from)
}

// Exchange until both docs hold the same Yjs state (CRDT quiescence).
const converge = (a: Peer, b: Peer): void => {
    for (let round = 0; round < 20; round++) {
        deliver(a, b)
        deliver(b, a)
        const sva = Y.encodeStateVector(a.doc)
        const svb = Y.encodeStateVector(b.doc)
        if (sva.length === svb.length && sva.every((byte, index) => byte === svb[index])) {return}
    }
    panic("did not converge")
}

const checksumHex = (graph: BoxGraph): string =>
    Array.from(graph.checksum(), byte => (byte & 0xff).toString(16).padStart(2, "0")).join("")

describe("YSync live collaboration", () => {
    let A: Peer
    let B: Peer

    const makePeer = async (name: string): Promise<Peer> => {
        const doc = new Y.Doc()
        const boxes = doc.getMap("boxes")
        const graph = new BoxGraph<any>(Option.wrap(factory as any))
        const sync = await YSync.populateRoom<any>({boxGraph: graph, boxes})
        return {name, doc, boxes, graph, sync}
    }

    beforeEach(async () => {
        A = await makePeer("A")
        B = await makePeer("B")
    })

    // Create a box on A and propagate it so BOTH peers share it as common ancestor state.
    const shared = (build: (graph: BoxGraph) => void): void => {
        edit(A, build)
        converge(A, B)
    }

    it("sanity: a concurrent edit on two different boxes converges", () => {
        edit(A, graph => {LeafBox.create(graph, UUID.generate()).label.setValue("from-A")})
        edit(B, graph => {LeafBox.create(graph, UUID.generate()).label.setValue("from-B")})
        converge(A, B)
        expect(A.graph.boxes().length).toBe(2)
        expect(B.graph.boxes().length).toBe(2)
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
    })

    it("concurrent writes to the SAME field converge to one value on both peers (LWW)", () => {
        const id = UUID.generate()
        shared(graph => {LeafBox.create(graph, id).count.setValue(0)})
        edit(A, graph => graph.findBox<LeafBox>(id).unwrap().count.setValue(10))
        edit(B, graph => graph.findBox<LeafBox>(id).unwrap().count.setValue(20))
        converge(A, B)
        const a = A.graph.findBox<LeafBox>(id).unwrap().count.getValue()
        const b = B.graph.findBox<LeafBox>(id).unwrap().count.getValue()
        expect(a).toBe(b) // both peers pick the SAME Yjs winner
        expect([10, 20]).toContain(a)
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
    })

    it("concurrent DELETE on A vs UPDATE on B of the same box converges (no resurrection split)", () => {
        const id = UUID.generate()
        shared(graph => {LeafBox.create(graph, id).label.setValue("start")})
        edit(A, graph => graph.findBox(id).unwrap().delete())
        edit(B, graph => graph.findBox<LeafBox>(id).unwrap().label.setValue("edited"))
        converge(A, B)
        expect(A.graph.findBox(id).nonEmpty()).toBe(B.graph.findBox(id).nonEmpty())
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
    })

    it("concurrent pointer retarget converges to one target on both peers", () => {
        const leaf1 = UUID.generate()
        const leaf2 = UUID.generate()
        const ref = UUID.generate()
        shared(graph => {
            LeafBox.create(graph, leaf1)
            LeafBox.create(graph, leaf2)
            RefBox.create(graph, ref)
        })
        edit(A, graph => graph.findBox<RefBox>(ref).unwrap().target.refer(graph.findBox<LeafBox>(leaf1).unwrap()))
        edit(B, graph => graph.findBox<RefBox>(ref).unwrap().target.refer(graph.findBox<LeafBox>(leaf2).unwrap()))
        converge(A, B)
        const ta = A.graph.findBox<RefBox>(ref).unwrap().target.targetAddress.unwrapOrNull()?.toString() ?? null
        const tb = B.graph.findBox<RefBox>(ref).unwrap().target.targetAddress.unwrapOrNull()?.toString() ?? null
        expect(ta).toBe(tb)
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
    })

    it("A deletes a pointer's target while B keeps pointing at it (dangling pointer, no crash)", () => {
        const leaf = UUID.generate()
        const ref = UUID.generate()
        shared(graph => {
            const target = LeafBox.create(graph, leaf)
            RefBox.create(graph, ref).target.refer(target)
        })
        edit(A, graph => graph.findBox(leaf).unwrap().delete())
        edit(B, graph => graph.findBox<LeafBox>(leaf).unwrap().label.setValue("still here"))
        converge(A, B)
        expect(A.graph.findBox(leaf).nonEmpty()).toBe(B.graph.findBox(leaf).nonEmpty())
        expect(A.graph.findBox(ref).nonEmpty()).toBe(true) // the ref box itself survives
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
    })

    it("both peers delete the same box concurrently", () => {
        const id = UUID.generate()
        shared(graph => {LeafBox.create(graph, id)})
        edit(A, graph => graph.findBox(id).unwrap().delete())
        edit(B, graph => graph.findBox(id).unwrap().delete())
        converge(A, B)
        expect(A.graph.findBox(id).isEmpty()).toBe(true)
        expect(B.graph.findBox(id).isEmpty()).toBe(true)
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
    })

    it("long offline divergence then reconnect (many ops each side)", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            for (let i = 0; i < 8; i++) {
                edit(A, graph => LeafBox.create(graph, UUID.generate()).count.setValue(i))
                edit(B, graph => LeafBox.create(graph, UUID.generate()).label.setValue(`b-${i}`))
            }
            converge(A, B)
            expect(A.graph.boxes().length).toBe(16)
            expect(B.graph.boxes().length).toBe(16)
            expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
        } finally {
            warn.mockRestore()
        }
    })

    it("concurrent pointers onto an EXCLUSIVE target (joint constraint violation)", () => {
        const target = UUID.generate()
        const ref1 = UUID.generate()
        const ref2 = UUID.generate()
        shared(graph => {
            ExclusiveBox.create(graph, target)
            RefBox.create(graph, ref1)
            RefBox.create(graph, ref2)
        })
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            // Each edit is locally valid (one incoming pointer); merged, the target has TWO.
            edit(A, graph => graph.findBox<RefBox>(ref1).unwrap().target.refer(graph.findBox(target).unwrap()))
            edit(B, graph => graph.findBox<RefBox>(ref2).unwrap().target.refer(graph.findBox(target).unwrap()))
            converge(A, B)
        } finally {
            warn.mockRestore()
        }
        // INVARIANTS THAT HOLD: no peer crashes, the Yjs doc converges, and each peer keeps the exclusive
        // rule locally (exactly one incoming pointer).
        expect(A.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
        expect(B.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
        // KNOWN LIMITATION (documented, not asserted-as-desired): the two GRAPHS DIVERGE. Each peer rejects
        // the other's constraint-violating batch and reverts locally while the doc keeps both edits, so A
        // ends with ref1->target and B with ref2->target — a permanent silent fork with no "next legitimate
        // operation" to auto-heal it (unlike the last-writer-wins primitive/pointer cases above). If YSync
        // ever learns to reconcile this, the two checksums will start matching and this expectation flips.
        expect(checksumHex(A.graph)).not.toBe(checksumHex(B.graph))
    })

    it("three peers with concurrent edits all converge", async () => {
        const doc = new Y.Doc()
        const boxes = doc.getMap("boxes")
        const graph = new BoxGraph<any>(Option.wrap(factory as any))
        const C: Peer = {name: "C", doc, boxes, graph, sync: await YSync.populateRoom<any>({boxGraph: graph, boxes})}
        edit(A, g => LeafBox.create(g, UUID.generate()).label.setValue("a"))
        edit(B, g => LeafBox.create(g, UUID.generate()).label.setValue("b"))
        edit(C, g => LeafBox.create(g, UUID.generate()).label.setValue("c"))
        // gossip until quiescent
        for (let round = 0; round < 20; round++) {
            converge(A, B)
            converge(B, C)
            converge(A, C)
            if (checksumHex(A.graph) === checksumHex(B.graph) && checksumHex(B.graph) === checksumHex(C.graph)) {break}
        }
        expect(A.graph.boxes().length).toBe(3)
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
        expect(checksumHex(B.graph)).toBe(checksumHex(C.graph))
    })
})
