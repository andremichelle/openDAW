import {describe, expect, it} from "vitest"
import {Address, Box, BoxConstruct, BoxGraph, NoPointers, PointerField, VertexVisitor} from "@opendaw/lib-box"
import {Maybe, Option, UUID} from "@opendaw/lib-std"
import {migrateDanglingPointers} from "./MigrateDanglingPointers"

// The rule is generic over any BoxGraph, so these exercise it against two minimal boxes rather than the
// studio registry: one carrying a free pointer, one carrying a mandatory pointer. Both are also valid
// pointer targets, so a cascade can be built. Mirrors the harness style of lib/box's graph.test.ts.

enum PointerType {Node = "Node"}

type OnePointerFields = { 0: PointerField<PointerType.Node> }

const pointerField = (parent: Box, fieldName: string, mandatory: boolean): PointerField<PointerType.Node> =>
    PointerField.create({parent, fieldKey: 0, fieldName, pointerRules: NoPointers, deprecated: false},
        PointerType.Node, mandatory)

class FreeBox extends Box<PointerType.Node, OnePointerFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes): FreeBox {
        return graph.stageBox(new FreeBox({
            uuid, graph, name: "FreeBox", pointerRules: {accepts: [PointerType.Node], mandatory: false}
        }))
    }
    private constructor(construct: BoxConstruct<PointerType.Node>) {super(construct)}
    protected initializeFields(): OnePointerFields {return {0: pointerField(this, "ref", false)}}
    accept<R>(_visitor: VertexVisitor<R>): Maybe<R> {return undefined}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get ref(): PointerField<PointerType.Node> {return this.getField(0)}
}

class BoundBox extends Box<PointerType.Node, OnePointerFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes): BoundBox {
        return graph.stageBox(new BoundBox({
            uuid, graph, name: "BoundBox", pointerRules: {accepts: [PointerType.Node], mandatory: false}
        }))
    }
    private constructor(construct: BoxConstruct<PointerType.Node>) {super(construct)}
    protected initializeFields(): OnePointerFields {return {0: pointerField(this, "owner", true)}}
    accept<R>(_visitor: VertexVisitor<R>): Maybe<R> {return undefined}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get owner(): PointerField<PointerType.Node> {return this.getField(0)}
}

// A uuid that was never staged is exactly what a merge leaves behind when another peer deleted the target.
// Assigning the raw address bypasses refer()'s live-vertex requirement, which is the only way to reach the
// state through public API.
const deadAddress = (): Address => Address.compose(UUID.generate())

const attached = (graph: BoxGraph, box: Box): boolean => graph.findBox(box.address.uuid).nonEmpty()

describe("migrateDanglingPointers", () => {
    it("clears a dangling free pointer and keeps its box", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const box = FreeBox.create(graph, UUID.generate())
        box.ref.targetAddress = Option.wrap(deadAddress())
        graph.endTransaction()

        expect(migrateDanglingPointers(graph)).toBe(1)
        expect(attached(graph, box)).toBe(true)
        expect(box.ref.isEmpty()).toBe(true)
    })

    it("deletes the owner of a dangling mandatory pointer", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const box = BoundBox.create(graph, UUID.generate())
        box.owner.targetAddress = Option.wrap(deadAddress())
        graph.endTransaction()

        expect(migrateDanglingPointers(graph)).toBe(1)
        expect(attached(graph, box)).toBe(false)
    })

    it("leaves a healthy graph untouched", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const anchor = FreeBox.create(graph, UUID.generate())
        const bound = BoundBox.create(graph, UUID.generate())
        bound.owner.refer(anchor)
        graph.endTransaction()

        expect(migrateDanglingPointers(graph)).toBe(0)
        expect(attached(graph, anchor)).toBe(true)
        expect(attached(graph, bound)).toBe(true)
    })

    // Deleting the owner of a dangling mandatory pointer cascades through the mandatory pointers aimed at
    // it. The pass must not then trip over the boxes that cascade already removed.
    it("survives a cascade that removes a box it had already recorded", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const head = FreeBox.create(graph, UUID.generate())
        head.ref.targetAddress = Option.wrap(deadAddress())
        const dependent = BoundBox.create(graph, UUID.generate())
        dependent.owner.refer(head)
        const orphaned = BoundBox.create(graph, UUID.generate())
        orphaned.owner.targetAddress = Option.wrap(deadAddress())
        graph.endTransaction()

        expect(() => migrateDanglingPointers(graph)).not.toThrow()
        expect(attached(graph, orphaned)).toBe(false)
        expect(head.ref.isEmpty()).toBe(true)
        expect(attached(graph, head)).toBe(true)
        expect(attached(graph, dependent)).toBe(true)
    })

    it("is idempotent", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const box = FreeBox.create(graph, UUID.generate())
        box.ref.targetAddress = Option.wrap(deadAddress())
        graph.endTransaction()

        expect(migrateDanglingPointers(graph)).toBe(1)
        expect(migrateDanglingPointers(graph)).toBe(0)
    })
})
