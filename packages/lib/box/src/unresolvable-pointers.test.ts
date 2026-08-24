import {describe, expect, it, vi} from "vitest"
import {JSONValue, Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {Address} from "./address"
import {Box, BoxConstruct} from "./box"
import {Field, FieldKeys} from "./field"
import {BoxGraph} from "./graph"
import {PointerField} from "./pointer"
import {NoPointers, VertexVisitor} from "./vertex"

// A pointer whose target is gone is the shape deserialization and a merged Yjs document deliver. The write
// API cannot produce it: refer() demands a live vertex and unstageBox refuses a box with incoming edges.
// These build it the only way the runtime can, by assigning the raw address, and by loading a graph that
// simply does not contain the box its pointers name.

enum Pointer {Target = "Target", Hook = "Hook"}

// A free pointer at a whole box, plus a hook other boxes can aim at.
type FreeBoxFields = { 0: PointerField<Pointer.Target>, 1: Field<Pointer.Hook> }

class FreeBox extends Box<Pointer.Target, FreeBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<FreeBox>): FreeBox {
        return graph.stageBox(new FreeBox({
            uuid, graph, name: "FreeBox", pointerRules: {accepts: [Pointer.Target], mandatory: false}
        }), constructor)
    }
    private constructor(construct: BoxConstruct<Pointer.Target>) {super(construct)}
    protected initializeFields(): FreeBoxFields {
        return {
            0: PointerField.create({
                parent: this, fieldKey: 0, fieldName: "ref", pointerRules: NoPointers, deprecated: false
            }, Pointer.Target, false),
            1: Field.hook({
                parent: this, fieldKey: 1, fieldName: "hook", deprecated: false,
                pointerRules: {accepts: [Pointer.Hook], mandatory: false}
            })
        }
    }
    accept<R>(_visitor: VertexVisitor<R>): Maybe<R> {return undefined}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get ref(): PointerField<Pointer.Target> {return this.getField(0)}
    get hook(): Field<Pointer.Hook> {return this.getField(1)}
}

// A mandatory pointer: it may never be unset, so its owner cannot outlive its target.
type BoundBoxFields = { 0: PointerField<Pointer.Hook> }

class BoundBox extends Box<Pointer.Target, BoundBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<BoundBox>): BoundBox {
        return graph.stageBox(new BoundBox({
            uuid, graph, name: "BoundBox", pointerRules: {accepts: [Pointer.Target], mandatory: false}
        }), constructor)
    }
    private constructor(construct: BoxConstruct<Pointer.Target>) {super(construct)}
    protected initializeFields(): BoundBoxFields {
        return {
            0: PointerField.create({
                parent: this, fieldKey: 0, fieldName: "owner", pointerRules: NoPointers, deprecated: false
            }, Pointer.Hook, true)
        }
    }
    accept<R>(_visitor: VertexVisitor<R>): Maybe<R> {return undefined}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get owner(): PointerField<Pointer.Hook> {return this.getField(0)}
}

const factory = (name: string, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>): Box => {
    switch (name) {
        case "FreeBox": return FreeBox.create(graph, uuid, constructor as Procedure<FreeBox>)
        case "BoundBox": return BoundBox.create(graph, uuid, constructor as Procedure<BoundBox>)
        default: return panic(`Unknown box: ${name}`)
    }
}

const newGraph = (): BoxGraph<any> => new BoxGraph<any>(Option.wrap(factory as any))

const deadAddress = (...fieldKeys: FieldKeys): Address => Address.compose(UUID.generate(), ...fieldKeys)

// Stage a box, then unstage it while it is still edge-free, and keep its address. The pointer assigned below
// therefore names a uuid the graph does not hold, exactly as a merge leaves it.
const vanished = (graph: BoxGraph): Address => {
    const gone = FreeBox.create(graph, UUID.generate())
    graph.unstageBox(gone)
    return gone.address
}

describe("BoxGraph.unresolvablePointers", () => {
    it("is empty for a healthy graph", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const target = FreeBox.create(graph, UUID.generate())
        FreeBox.create(graph, UUID.generate(), box => box.ref.refer(target))
        graph.endTransaction()
        expect(graph.unresolvablePointers()).toEqual([])
    })

    it("is empty when a pointer is simply unset", () => {
        const graph = newGraph()
        graph.beginTransaction()
        FreeBox.create(graph, UUID.generate())
        graph.endTransaction()
        expect(graph.unresolvablePointers()).toEqual([])
    })

    it("finds a pointer naming a box that is not there", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = FreeBox.create(graph, UUID.generate())
        box.ref.targetAddress = Option.wrap(vanished(graph))
        graph.endTransaction()
        expect(graph.unresolvablePointers()).toEqual([box.ref])
    })

    it("finds a pointer naming a FIELD of a box that is not there", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = BoundBox.create(graph, UUID.generate())
        box.owner.targetAddress = Option.wrap(deadAddress(1))
        graph.endTransaction()
        expect(graph.unresolvablePointers()).toEqual([box.owner])
    })

    it("finds a pointer naming a field key the target box does not have", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const target = FreeBox.create(graph, UUID.generate())
        const box = BoundBox.create(graph, UUID.generate())
        box.owner.targetAddress = Option.wrap(Address.compose(target.address.uuid, 99))
        graph.endTransaction()
        expect(graph.unresolvablePointers()).toEqual([box.owner])
    })

    it("finds every one of them", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const first = FreeBox.create(graph, UUID.generate())
        const second = FreeBox.create(graph, UUID.generate())
        first.ref.targetAddress = Option.wrap(vanished(graph))
        second.ref.targetAddress = Option.wrap(vanished(graph))
        graph.endTransaction()
        expect(graph.unresolvablePointers().length).toBe(2)
    })
})

describe("BoxGraph.clearUnresolvablePointers", () => {
    it("clears them and reports how many", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = FreeBox.create(graph, UUID.generate())
        box.ref.targetAddress = Option.wrap(vanished(graph))
        graph.endTransaction()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(graph.clearUnresolvablePointers()).toBe(1)
        warn.mockRestore()
        expect(box.ref.isEmpty()).toBe(true)
        expect(graph.unresolvablePointers()).toEqual([])
    })

    it("is idempotent and opens no transaction when there is nothing to do", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = FreeBox.create(graph, UUID.generate())
        box.ref.targetAddress = Option.wrap(vanished(graph))
        graph.endTransaction()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(graph.clearUnresolvablePointers()).toBe(1)
        expect(graph.clearUnresolvablePointers()).toBe(0)
        warn.mockRestore()
        expect(graph.inTransaction()).toBe(false)
    })

    it("clears a MANDATORY pointer without throwing, which endTransaction would reject", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = BoundBox.create(graph, UUID.generate())
        box.owner.targetAddress = Option.wrap(deadAddress(1))
        graph.endTransaction()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(() => graph.clearUnresolvablePointers()).not.toThrow()
        warn.mockRestore()
        expect(box.owner.isEmpty()).toBe(true)
        expect(box.isAttached(), "clearing never deletes").toBe(true)
    })

    it("leaves resolvable pointers alone", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const target = FreeBox.create(graph, UUID.generate())
        const keeper = FreeBox.create(graph, UUID.generate(), box => box.ref.refer(target))
        const broken = FreeBox.create(graph, UUID.generate())
        broken.ref.targetAddress = Option.wrap(vanished(graph))
        graph.endTransaction()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(graph.clearUnresolvablePointers()).toBe(1)
        warn.mockRestore()
        expect(keeper.ref.targetVertex.nonEmpty()).toBe(true)
        expect(broken.ref.isEmpty()).toBe(true)
    })

    it("runs inside a transaction the caller already opened, and leaves it open", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = FreeBox.create(graph, UUID.generate())
        box.ref.targetAddress = Option.wrap(vanished(graph))
        graph.endTransaction()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        graph.beginTransaction()
        expect(graph.clearUnresolvablePointers()).toBe(1)
        expect(graph.inTransaction(), "still the caller's transaction").toBe(true)
        graph.endTransaction()
        warn.mockRestore()
        expect(box.ref.isEmpty()).toBe(true)
    })
})

// Deserialization must NOT clear: a clipboard subset points outside itself on purpose, and wiping those
// edges silently loses the paste target.
describe("deserialization keeps a deliberately partial graph intact", () => {
    const partial = (): JSONValue => {
        const source = newGraph()
        source.beginTransaction()
        const outside = FreeBox.create(source, UUID.generate())
        const copied = FreeBox.create(source, UUID.generate(), box => box.ref.refer(outside))
        source.endTransaction()
        const json = source.toJSON() as Record<string, JSONValue>
        return {[copied.address.toString()]: json[copied.address.toString()]} as JSONValue
    }

    it("fromJSON keeps the edge that leaves the subset", () => {
        const graph = newGraph()
        graph.fromJSON(partial(), false)
        expect(graph.boxes().length).toBe(1)
        expect(graph.unresolvablePointers().length, "still dangling, on purpose").toBe(1)
    })

    it("fromArrayBuffer keeps the edge that leaves the subset", () => {
        const source = newGraph()
        source.beginTransaction()
        const outside = FreeBox.create(source, UUID.generate())
        FreeBox.create(source, UUID.generate(), box => box.ref.refer(outside))
        source.endTransaction()
        source.beginTransaction()
        outside.delete()
        source.endTransaction()
        const graph = newGraph()
        graph.fromArrayBuffer(source.toArrayBuffer(), false)
        expect(graph.boxes().length).toBe(1)
    })

    it("but the caller can ask for it afterwards", () => {
        const graph = newGraph()
        graph.fromJSON(partial(), false)
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(graph.clearUnresolvablePointers()).toBe(1)
        warn.mockRestore()
        expect(graph.unresolvablePointers()).toEqual([])
    })
})

describe("GraphEdges.unsatisfiedMandatoryPointers", () => {
    it("is empty for a healthy graph", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const host = FreeBox.create(graph, UUID.generate())
        BoundBox.create(graph, UUID.generate(), box => box.owner.refer(host.hook))
        graph.endTransaction()
        expect(graph.edges().unsatisfiedMandatoryPointers()).toEqual([])
    })

    it("does not report a free pointer that is simply unset", () => {
        const graph = newGraph()
        graph.beginTransaction()
        FreeBox.create(graph, UUID.generate())
        graph.endTransaction()
        expect(graph.edges().unsatisfiedMandatoryPointers()).toEqual([])
    })

    it("reports a mandatory pointer once its dead target has been cleared", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = BoundBox.create(graph, UUID.generate())
        box.owner.targetAddress = Option.wrap(deadAddress(1))
        graph.endTransaction()
        expect(graph.edges().unsatisfiedMandatoryPointers(), "not yet, the address is set").toEqual([])
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        graph.clearUnresolvablePointers()
        warn.mockRestore()
        expect(graph.edges().unsatisfiedMandatoryPointers()).toEqual([box.owner])
    })

    it("is empty again once the owner is gone", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const box = BoundBox.create(graph, UUID.generate())
        box.owner.targetAddress = Option.wrap(deadAddress(1))
        graph.endTransaction()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        graph.clearUnresolvablePointers()
        warn.mockRestore()
        graph.beginTransaction()
        box.delete()
        graph.endTransaction()
        expect(graph.edges().unsatisfiedMandatoryPointers()).toEqual([])
    })

    // The two steps together: clear, then remove whoever cannot live without a target. Nothing in either
    // step knows what any particular box is.
    it("clear then delete leaves a graph that validates", () => {
        const graph = newGraph()
        graph.beginTransaction()
        const survivor = FreeBox.create(graph, UUID.generate())
        survivor.ref.targetAddress = Option.wrap(vanished(graph))
        const doomed = BoundBox.create(graph, UUID.generate())
        doomed.owner.targetAddress = Option.wrap(deadAddress(1))
        graph.endTransaction()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        graph.clearUnresolvablePointers()
        warn.mockRestore()
        graph.beginTransaction()
        graph.edges().unsatisfiedMandatoryPointers().forEach(pointer => pointer.box.delete())
        graph.endTransaction()
        expect(survivor.isAttached(), "a free pointer only loses its edge").toBe(true)
        expect(survivor.ref.isEmpty()).toBe(true)
        expect(doomed.isAttached(), "a mandatory one costs its owner").toBe(false)
        expect(graph.unresolvablePointers()).toEqual([])
        expect(graph.edges().unsatisfiedMandatoryPointers()).toEqual([])
    })
})
