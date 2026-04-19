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

// --- Minimal box fixtures ------------------------------------------------

enum Pointer {Target}

interface TestVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitLeafBox?(box: LeafBox): RETURN
    visitRefBox?(box: RefBox): RETURN
}

type LeafBoxFields = {
    1: Int32Field
    2: StringField
    3: BooleanField
}

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
            1: Int32Field.create(
                {parent: this, fieldKey: 1, fieldName: "count", deprecated: false, pointerRules: NoPointers},
                "any", "none"),
            2: StringField.create(
                {parent: this, fieldKey: 2, fieldName: "label", deprecated: false, pointerRules: NoPointers}),
            3: BooleanField.create(
                {parent: this, fieldKey: 3, fieldName: "flag", deprecated: false, pointerRules: NoPointers},
                false)
        }
    }

    accept<R>(visitor: TestVisitor<R>): Maybe<R> {return safeExecute(visitor.visitLeafBox, this)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get count(): Int32Field {return this.getField(1)}
    get label(): StringField {return this.getField(2)}
    get flag(): BooleanField {return this.getField(3)}
}

type RefBoxFields = {
    1: PointerField<Pointer.Target>
}

class RefBox extends Box<UnreferenceableType, RefBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<RefBox>): RefBox {
        return graph.stageBox(new RefBox({uuid, graph, name: "RefBox", pointerRules: NoPointers}), constructor)
    }

    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}

    protected initializeFields(): RefBoxFields {
        return {
            1: PointerField.create(
                {parent: this, fieldKey: 1, fieldName: "target", deprecated: false, pointerRules: NoPointers},
                Pointer.Target, false)
        }
    }

    accept<R>(visitor: TestVisitor<R>): Maybe<R> {return safeExecute(visitor.visitRefBox, this)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get target(): PointerField<Pointer.Target> {return this.getField(1)}
}

const factory = (name: string, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>): Box => {
    switch (name) {
        case "LeafBox":
            return LeafBox.create(graph, uuid, constructor as Procedure<LeafBox>)
        case "RefBox":
            return RefBox.create(graph, uuid, constructor as Procedure<RefBox>)
        default:
            return panic(`Unknown box: ${name}`)
    }
}

// --- Scene ---------------------------------------------------------------

interface Scene {
    doc: Y.Doc
    boxes: Y.Map<unknown>
    graph: BoxGraph
    sync: YSync<any>
}

const makeScene = async (): Promise<Scene> => {
    const doc = new Y.Doc()
    const boxes = doc.getMap("boxes")
    const graph = new BoxGraph<any>(Option.wrap(factory as any))
    const sync = await YSync.populateRoom<any>({boxGraph: graph, boxes})
    return {doc, boxes, graph, sync}
}

const beginCommit = (graph: BoxGraph, fn: () => void): void => {
    graph.beginTransaction()
    try {
        fn()
    } finally {
        graph.endTransaction()
    }
}

// --- Tests ---------------------------------------------------------------

describe("YSync.flush", () => {
    let scene: Scene

    beforeEach(async () => {
        scene = await makeScene()
    })

    it("writes new boxes, primitives, and pointers into yjs", () => {
        let leafId: UUID.Bytes | undefined
        let refId: UUID.Bytes | undefined
        beginCommit(scene.graph, () => {
            const leaf = LeafBox.create(scene.graph, UUID.generate())
            leaf.count.setValue(42)
            leaf.label.setValue("hello")
            leaf.flag.setValue(true)
            const ref = RefBox.create(scene.graph, UUID.generate())
            ref.target.refer(leaf)
            leafId = leaf.address.uuid
            refId = ref.address.uuid
        })

        expect(scene.boxes.size).toBe(2)

        const leafMap = scene.boxes.get(UUID.toString(leafId!)) as Y.Map<unknown>
        expect(leafMap.get("name")).toBe("LeafBox")
        const leafFields = leafMap.get("fields") as Y.Map<unknown>
        expect(leafFields).toBeInstanceOf(Y.Map)
        expect(leafFields.get("1")).toBe(42)
        expect(leafFields.get("2")).toBe("hello")
        expect(leafFields.get("3")).toBe(true)

        const refMap = scene.boxes.get(UUID.toString(refId!)) as Y.Map<unknown>
        const refFields = refMap.get("fields") as Y.Map<unknown>
        expect(typeof refFields.get("1")).toBe("string")
    })

    it("drops phantom boxes created and deleted in the same transaction", () => {
        let phantomId: UUID.Bytes | undefined
        let survivorId: UUID.Bytes | undefined
        beginCommit(scene.graph, () => {
            const phantom = LeafBox.create(scene.graph, UUID.generate())
            phantom.count.setValue(7)
            phantomId = phantom.address.uuid
            phantom.delete()
            const survivor = LeafBox.create(scene.graph, UUID.generate())
            survivor.label.setValue("keep")
            survivorId = survivor.address.uuid
        })

        expect(scene.boxes.has(UUID.toString(phantomId!))).toBe(false)
        expect(scene.boxes.has(UUID.toString(survivorId!))).toBe(true)
        const survivorMap = scene.boxes.get(UUID.toString(survivorId!)) as Y.Map<unknown>
        const fields = survivorMap.get("fields") as Y.Map<unknown>
        expect(fields.get("2")).toBe("keep")
    })

    it("updates mutable fields on existing boxes", () => {
        let uuid: UUID.Bytes | undefined
        beginCommit(scene.graph, () => {
            const leaf = LeafBox.create(scene.graph, UUID.generate())
            leaf.count.setValue(1)
            uuid = leaf.address.uuid
        })

        const leaf = scene.graph.findBox<LeafBox>(uuid!).unwrap()
        beginCommit(scene.graph, () => {
            leaf.count.setValue(99)
            leaf.flag.setValue(true)
        })

        const map = scene.boxes.get(UUID.toString(uuid!)) as Y.Map<unknown>
        const fields = map.get("fields") as Y.Map<unknown>
        expect(fields.get("1")).toBe(99)
        expect(fields.get("3")).toBe(true)
    })

    it("drains the queue even if a later flush throws", () => {
        // First commit succeeds and establishes the box in yjs.
        let uuid: UUID.Bytes | undefined
        beginCommit(scene.graph, () => {
            const leaf = LeafBox.create(scene.graph, UUID.generate())
            leaf.label.setValue("initial")
            uuid = leaf.address.uuid
        })
        expect(scene.boxes.has(UUID.toString(uuid!))).toBe(true)

        // Simulate drift: wipe the "fields" sub-map of the stored box so the next
        // pointer/primitive update cannot traverse into it.
        const map = scene.boxes.get(UUID.toString(uuid!)) as Y.Map<unknown>
        map.delete("fields")

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            // This used to throw a TypeError inside transact and leave #updates populated.
            expect(() => beginCommit(scene.graph, () => {
                const leaf = scene.graph.findBox<LeafBox>(uuid!).unwrap()
                leaf.label.setValue("second")
            })).not.toThrow()
            expect(warn).toHaveBeenCalled()
        } finally {
            warn.mockRestore()
        }

        // A subsequent transaction must still be able to flush cleanly.
        let secondId: UUID.Bytes | undefined
        beginCommit(scene.graph, () => {
            const next = LeafBox.create(scene.graph, UUID.generate())
            next.label.setValue("third")
            secondId = next.address.uuid
        })
        expect(scene.boxes.has(UUID.toString(secondId!))).toBe(true)
        const nextMap = scene.boxes.get(UUID.toString(secondId!)) as Y.Map<unknown>
        const nextFields = nextMap.get("fields") as Y.Map<unknown>
        expect(nextFields.get("2")).toBe("third")
    })

    it("clears pending updates on aborted/rolled-back transactions", () => {
        // Stage work then abort; the pending queue must not leak into the next tx.
        scene.graph.beginTransaction()
        LeafBox.create(scene.graph, UUID.generate()).count.setValue(123)
        scene.graph.abortTransaction()

        expect(scene.boxes.size).toBe(0)

        let uuid: UUID.Bytes | undefined
        beginCommit(scene.graph, () => {
            const leaf = LeafBox.create(scene.graph, UUID.generate())
            leaf.label.setValue("fresh")
            uuid = leaf.address.uuid
        })
        expect(scene.boxes.size).toBe(1)
        const map = scene.boxes.get(UUID.toString(uuid!)) as Y.Map<unknown>
        const fields = map.get("fields") as Y.Map<unknown>
        expect(fields.get("2")).toBe("fresh")
    })

    it("mirrors the crash scenario: create + mutate + cascade-delete in one transaction", () => {
        // A close analogue of report #920: a newly-created box is mutated and, in
        // the same transaction, another existing box is deleted (defer + unstage).
        // The queue contains New, Pointer, Primitive and Delete updates; a missing
        // "fields" sub-map on the box being deleted used to take down the whole
        // transact callback. With the fix, the flush must still complete and leave
        // the yjs state consistent with the graph.
        let survivorId: UUID.Bytes | undefined
        let oldLeafId: UUID.Bytes | undefined

        // Pre-existing state.
        beginCommit(scene.graph, () => {
            const oldLeaf = LeafBox.create(scene.graph, UUID.generate())
            oldLeaf.label.setValue("old")
            oldLeafId = oldLeaf.address.uuid
        })

        // Intentionally corrupt the stored box to provoke the broken-fields path.
        const leafMap = scene.boxes.get(UUID.toString(oldLeafId!)) as Y.Map<unknown>
        leafMap.delete("fields")

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            beginCommit(scene.graph, () => {
                const newLeaf = LeafBox.create(scene.graph, UUID.generate())
                newLeaf.label.setValue("survivor")
                survivorId = newLeaf.address.uuid

                const ref = RefBox.create(scene.graph, UUID.generate())
                ref.target.refer(newLeaf)

                scene.graph.findBox<LeafBox>(oldLeafId!).unwrap().delete()
            })
        } finally {
            warn.mockRestore()
        }

        // Old leaf is gone, new leaf is present with all fields.
        expect(scene.boxes.has(UUID.toString(oldLeafId!))).toBe(false)
        const survivorMap = scene.boxes.get(UUID.toString(survivorId!)) as Y.Map<unknown>
        expect(survivorMap).toBeInstanceOf(Y.Map)
        const survivorFields = survivorMap.get("fields") as Y.Map<unknown>
        expect(survivorFields.get("2")).toBe("survivor")

        // Graph and yjs agree on box count.
        expect(scene.boxes.size).toBe(scene.graph.boxes().length)
    })

    it("tolerates a pointer update whose field path is broken mid-way", () => {
        let refId: UUID.Bytes | undefined
        let leafId: UUID.Bytes | undefined
        beginCommit(scene.graph, () => {
            const leaf = LeafBox.create(scene.graph, UUID.generate())
            const ref = RefBox.create(scene.graph, UUID.generate())
            ref.target.refer(leaf)
            refId = ref.address.uuid
            leafId = leaf.address.uuid
        })

        const refMap = scene.boxes.get(UUID.toString(refId!)) as Y.Map<unknown>
        const refFields = refMap.get("fields") as Y.Map<unknown>
        // Pretend the pointer slot was swapped to a non-map value (drift).
        refFields.set("1", "garbage")

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            expect(() => beginCommit(scene.graph, () => {
                const ref = scene.graph.findBox<RefBox>(refId!).unwrap()
                ref.target.defer()
            })).not.toThrow()
        } finally {
            warn.mockRestore()
        }

        expect(scene.graph.findBox(leafId!).nonEmpty()).toBe(true)
    })
})
