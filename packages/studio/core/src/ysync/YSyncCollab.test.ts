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

// A RefBox whose pointer is MANDATORY: it may never dangle, so when the reconcile has to drop its edge it
// must drop the whole owner box instead of clearing the pointer.
class MandatoryRefBox extends Box<UnreferenceableType, RefBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<MandatoryRefBox>): MandatoryRefBox {
        return graph.stageBox(new MandatoryRefBox({uuid, graph, name: "MandatoryRefBox", pointerRules: NoPointers}), constructor)
    }
    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}
    protected initializeFields(): RefBoxFields {
        return {
            1: PointerField.create({parent: this, fieldKey: 1, fieldName: "target", deprecated: false, pointerRules: NoPointers}, Pointer.Target, true)
        }
    }
    accept<R>(visitor: TestVisitor<R>): Maybe<R> {return safeExecute((visitor as any).visitMandatoryRefBox, this)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get target(): PointerField<Pointer.Target> {return this.getField(1)}
}

const factory = (name: string, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>): Box => {
    switch (name) {
        case "LeafBox": return LeafBox.create(graph, uuid, constructor as Procedure<LeafBox>)
        case "RefBox": return RefBox.create(graph, uuid, constructor as Procedure<RefBox>)
        case "ExclusiveBox": return ExclusiveBox.create(graph, uuid, constructor as Procedure<ExclusiveBox>)
        case "MandatoryRefBox": return MandatoryRefBox.create(graph, uuid, constructor as Procedure<MandatoryRefBox>)
        default: return panic(`Unknown box: ${name}`)
    }
}

// A seeded PRNG (mulberry32) so fuzz failures reproduce from the logged seed.
const mulberry32 = (seed: number): (() => number) => () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
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
        // With deterministic reconciliation, the joint constraint violation NO LONGER forks the room:
        // each peer keeps exactly one incoming pointer (the exclusive rule holds) AND both peers land on the
        // SAME survivor (the lowest-addressed source), so the graphs converge.
        expect(A.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
        expect(B.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
        expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))

        // A LATE joiner reads the (still over-specified) document and must land on the same graph, not reject
        // the whole snapshot — joinRoom reconciles deterministically too.
        const joinGraph = new BoxGraph<any>(Option.wrap(factory as any))
        const joinDoc = new Y.Doc()
        Y.applyUpdate(joinDoc, Y.encodeStateAsUpdate(A.doc))
        return YSync.joinRoom<any>({boxGraph: joinGraph, boxes: joinDoc.getMap("boxes")}).then(() => {
            expect(joinGraph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
            expect(checksumHex(joinGraph)).toBe(checksumHex(A.graph))
        })
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

    // The reconcile keeps the lowest-addressed incoming pointer. `survivorUuid` reports whose it is.
    const survivorUuid = (peer: Peer, target: UUID.Bytes): string =>
        UUID.toString(peer.graph.findBox(target).unwrap().incomingEdges()[0].box.address.uuid)
    const lowestUuid = (...ids: ReadonlyArray<UUID.Bytes>): string =>
        ids.map(UUID.toString).sort((a, b) => a.localeCompare(b))[0]

    it("the exclusive survivor is the lowest-addressed source, independent of who attached it", () => {
        const target = UUID.generate()
        const ref1 = UUID.generate()
        const ref2 = UUID.generate()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            shared(graph => {ExclusiveBox.create(graph, target); RefBox.create(graph, ref1); RefBox.create(graph, ref2)})
            // A attaches the HIGHER-addressed ref, B the LOWER: the winner must still be the lower one.
            const [low, high] = [ref1, ref2].sort((a, b) => UUID.toString(a).localeCompare(UUID.toString(b)))
            edit(A, graph => graph.findBox<RefBox>(high).unwrap().target.refer(graph.findBox(target).unwrap()))
            edit(B, graph => graph.findBox<RefBox>(low).unwrap().target.refer(graph.findBox(target).unwrap()))
            converge(A, B)
            expect(survivorUuid(A, target)).toBe(lowestUuid(ref1, ref2))
            expect(survivorUuid(B, target)).toBe(lowestUuid(ref1, ref2))
            expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
        } finally {warn.mockRestore()}
    })

    it("many refs racing onto one exclusive target converge to the single lowest-addressed winner", async () => {
        const target = UUID.generate()
        const refs = Array.from({length: 4}, () => UUID.generate())
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            // One peer per ref, so no single client ever holds a local exclusive violation; the conflict
            // exists only in the merge.
            const peers: Array<Peer> = [A, B]
            for (let index = 0; index < 2; index++) {
                const doc = new Y.Doc()
                const boxes = doc.getMap("boxes")
                const graph = new BoxGraph<any>(Option.wrap(factory as any))
                peers.push({name: `X${index}`, doc, boxes, graph, sync: await YSync.populateRoom<any>({boxGraph: graph, boxes})})
            }
            const gossip = (): void => {
                for (let round = 0; round < 40; round++) {
                    for (const from of peers) {for (const to of peers) {if (from !== to) {deliver(from, to)}}}
                    const first = checksumHex(peers[0].graph)
                    if (peers.every(peer => checksumHex(peer.graph) === first)) {return}
                }
                panic("no convergence")
            }
            edit(A, graph => {ExclusiveBox.create(graph, target); refs.forEach(id => RefBox.create(graph, id))})
            gossip()
            peers.forEach((peer, index) => edit(peer,
                graph => graph.findBox<RefBox>(refs[index]).unwrap().target.refer(graph.findBox(target).unwrap())))
            gossip()
            for (const peer of peers) {
                expect(peer.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
                expect(survivorUuid(peer, target)).toBe(lowestUuid(...refs))
            }
            const reference = checksumHex(peers[0].graph)
            for (const peer of peers) {expect(checksumHex(peer.graph)).toBe(reference)}
        } finally {warn.mockRestore()}
    })

    it("mandatory pointers: reconcile drops the losing OWNER box, not just the edge", () => {
        const target = UUID.generate()
        const ownerA = UUID.generate()
        const ownerB = UUID.generate()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            shared(graph => {ExclusiveBox.create(graph, target)})
            edit(A, graph => MandatoryRefBox.create(graph, ownerA).target.refer(graph.findBox(target).unwrap()))
            edit(B, graph => MandatoryRefBox.create(graph, ownerB).target.refer(graph.findBox(target).unwrap()))
            converge(A, B)
            const loser = lowestUuid(ownerA, ownerB) === UUID.toString(ownerA) ? ownerB : ownerA
            // The losing owner is deleted on BOTH peers (a mandatory pointer may not dangle).
            expect(A.graph.findBox(loser).isEmpty()).toBe(true)
            expect(B.graph.findBox(loser).isEmpty()).toBe(true)
            expect(A.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
            expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
        } finally {warn.mockRestore()}
    })

    it("a batch mixing a valid edit with a violating pointer keeps the valid edit", () => {
        const target = UUID.generate()
        const ref1 = UUID.generate()
        const ref2 = UUID.generate()
        const leaf = UUID.generate()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            shared(graph => {
                ExclusiveBox.create(graph, target)
                RefBox.create(graph, ref1)
                RefBox.create(graph, ref2)
                LeafBox.create(graph, leaf)
            })
            edit(A, graph => graph.findBox<RefBox>(ref1).unwrap().target.refer(graph.findBox(target).unwrap()))
            // ONE transaction on B: a perfectly valid label edit AND the pointer that will lose reconciliation.
            edit(B, graph => {
                graph.findBox<LeafBox>(leaf).unwrap().label.setValue("must-survive")
                graph.findBox<RefBox>(ref2).unwrap().target.refer(graph.findBox(target).unwrap())
            })
            converge(A, B)
            // The offending edge was dropped, but the unrelated valid edit in the same batch was preserved.
            expect(A.graph.findBox<LeafBox>(leaf).unwrap().label.getValue()).toBe("must-survive")
            expect(B.graph.findBox<LeafBox>(leaf).unwrap().label.getValue()).toBe("must-survive")
            expect(A.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
            expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
        } finally {warn.mockRestore()}
    })

    it("does not reconcile when concurrent edits break no constraint", () => {
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
        try {
            const leafA = UUID.generate()
            const leafB = UUID.generate()
            shared(graph => {LeafBox.create(graph, leafA); LeafBox.create(graph, leafB)})
            edit(A, graph => graph.findBox<LeafBox>(leafA).unwrap().count.setValue(1))
            edit(B, graph => graph.findBox<LeafBox>(leafB).unwrap().label.setValue("b"))
            converge(A, B)
            const reconciled = debug.mock.calls.some(args =>
                typeof args[0] === "string" && args[0].includes("reconciled deterministically"))
            expect(reconciled).toBe(false)
            expect(checksumHex(A.graph)).toBe(checksumHex(B.graph))
        } finally {debug.mockRestore()}
    })

    it("re-delivering after convergence changes nothing (stable, no oscillation)", () => {
        const target = UUID.generate()
        const ref1 = UUID.generate()
        const ref2 = UUID.generate()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            shared(graph => {ExclusiveBox.create(graph, target); RefBox.create(graph, ref1); RefBox.create(graph, ref2)})
            edit(A, graph => graph.findBox<RefBox>(ref1).unwrap().target.refer(graph.findBox(target).unwrap()))
            edit(B, graph => graph.findBox<RefBox>(ref2).unwrap().target.refer(graph.findBox(target).unwrap()))
            converge(A, B)
            const before = checksumHex(A.graph)
            for (let i = 0; i < 3; i++) {deliver(A, B); deliver(B, A)}
            expect(checksumHex(A.graph)).toBe(before)
            expect(checksumHex(B.graph)).toBe(before)
            expect(A.graph.findBox(target).unwrap().incomingEdges()).toHaveLength(1)
        } finally {warn.mockRestore()}
    })

    // Randomised multi-peer schedules. Exclusive attachments are kept APPEND-ONLY (a ref is never detached or
    // retargeted away from an exclusive target) because the prototype suppresses its repair from the doc, so
    // removing an exclusive survivor would diverge live peers from a fresh joiner. Within that regime the
    // reconcile is a pure function of the converged doc, so every peer AND a late joiner must agree.
    it("fuzz: randomised concurrent schedules converge across peers and a late joiner", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
        try {
            for (const seed of [1, 2, 5, 9, 13, 17, 23, 42, 99, 123, 777, 2024]) {
                const rnd = mulberry32(seed)
                const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(rnd() * items.length)]
                const peers: Array<Peer> = []
                for (let index = 0; index < 4; index++) {
                    const doc = new Y.Doc()
                    const boxes = doc.getMap("boxes")
                    const graph = new BoxGraph<any>(Option.wrap(factory as any))
                    peers.push({name: `P${index}`, doc, boxes, graph, sync: await YSync.populateRoom<any>({boxGraph: graph, boxes})})
                }
                const gossip = (): void => {
                    for (let round = 0; round < 40; round++) {
                        for (const from of peers) {for (const to of peers) {if (from !== to) {deliver(from, to)}}}
                        const first = checksumHex(peers[0].graph)
                        if (peers.every(peer => checksumHex(peer.graph) === first)) {return}
                    }
                    panic(`seed ${seed}: no global convergence`)
                }
                const excl = [UUID.generate(), UUID.generate(), UUID.generate()]
                const leaves = [UUID.generate(), UUID.generate()]
                const refs = Array.from({length: 6}, () => UUID.generate())
                edit(peers[0], graph => {
                    excl.forEach(id => ExclusiveBox.create(graph, id))
                    leaves.forEach(id => LeafBox.create(graph, id))
                    refs.forEach(id => RefBox.create(graph, id))
                })
                gossip()
                const targets = [...excl, ...leaves]
                for (let round = 0; round < 30; round++) {
                    for (const peer of peers) {
                        if (rnd() < 0.5) {continue}
                        const edits = 1 + Math.floor(rnd() * 2)
                        for (let e = 0; e < edits; e++) {
                            const roll = rnd()
                            const refBox = peer.graph.findBox<RefBox>(pick(refs)).unwrap()
                            const targetExclusive = refBox.target.targetVertex.mapOr(
                                vertex => vertex.box.pointerRules.exclusive, false)
                            if (roll < 0.55) {
                                const tBox = peer.graph.findBox(pick(targets)).unwrap()
                                const occupied = tBox.pointerRules.exclusive
                                    && tBox.incomingEdges().some(pointer => pointer.box !== refBox)
                                if (occupied) {continue} // keep each peer LOCALLY valid; conflicts arise on merge
                                if (targetExclusive) {continue} // append-only for exclusive survivors
                                edit(peer, () => refBox.target.refer(tBox))
                            } else if (roll < 0.75) {
                                if (refBox.target.isEmpty() || targetExclusive) {continue} // never detach an exclusive
                                edit(peer, () => refBox.target.defer())
                            } else {
                                const leafBox = peer.graph.findBox<LeafBox>(pick(leaves)).unwrap()
                                edit(peer, () => leafBox.count.setValue(Math.floor(rnd() * 1000)))
                            }
                        }
                    }
                    const from = pick(peers)
                    const to = pick(peers)
                    if (from !== to) {converge(from, to)}
                }
                gossip()
                const reference = checksumHex(peers[0].graph)
                for (const peer of peers) {
                    expect(checksumHex(peer.graph), `seed ${seed} peer ${peer.name}`).toBe(reference)
                    for (const id of excl) {
                        expect(peer.graph.findBox(id).unwrap().incomingEdges().length,
                            `seed ${seed} exclusive overflow`).toBeLessThanOrEqual(1)
                    }
                }
                // A late joiner reconstructs from the document alone and must match the live room.
                const joinGraph = new BoxGraph<any>(Option.wrap(factory as any))
                const joinDoc = new Y.Doc()
                Y.applyUpdate(joinDoc, Y.encodeStateAsUpdate(peers[0].doc))
                await YSync.joinRoom<any>({boxGraph: joinGraph, boxes: joinDoc.getMap("boxes")})
                expect(checksumHex(joinGraph), `seed ${seed} joiner`).toBe(reference)
            }
        } finally {
            warn.mockRestore()
            debug.mockRestore()
        }
    })
})
