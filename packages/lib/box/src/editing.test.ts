import {beforeEach, describe, expect, it} from "vitest"
import {BooleanField, BoxGraph} from "./"
import {PointerField, UnreferenceableType} from "./pointer"
import {Box, BoxConstruct} from "./box"
import {NoPointers, VertexVisitor} from "./vertex"
import {Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {BoxEditing} from "./editing"

enum PointerType {A, B}

interface BoxVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitBarBox?(box: BarBox): RETURN
}

type BarBoxFields = {
    1: BooleanField
    2: PointerField<PointerType.A>
}

class BarBox extends Box<UnreferenceableType, BarBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<BarBox>): BarBox {
        return graph.stageBox(new BarBox({uuid, graph, name: "BarBox", pointerRules: NoPointers}), constructor)
    }

    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}

    protected initializeFields(): BarBoxFields {
        return {
            1: BooleanField.create({
                parent: this,
                fieldKey: 1,
                fieldName: "A",
                pointerRules: NoPointers
            }, false),
            2: PointerField.create({
                parent: this,
                fieldKey: 2,
                fieldName: "B",
                pointerRules: NoPointers
            }, PointerType.A, false)
        }
    }

    accept<R>(visitor: BoxVisitor<R>): Maybe<R> {return safeExecute(visitor.visitBarBox, this)}

    get bool(): BooleanField {return this.getField(1)}
    get pointer(): PointerField<PointerType.A> {return this.getField(2)}
}

describe("editing", () => {
    interface TestScene {
        graph: BoxGraph
        editing: BoxEditing
    }

    beforeEach<TestScene>((scene: TestScene) => {
        const graph = new BoxGraph<any>(Option.wrap((name: keyof any, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>) => {
            switch (name) {
                case "BarBox":
                    return BarBox.create(graph, uuid, constructor)
                default:
                    return panic()
            }
        }))
        scene.graph = graph
        scene.editing = new BoxEditing(graph)
    })

    it("should be locked/unlocked", (scene: TestScene) => {
        const barBox = scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate())).unwrap()
        const barUuid = barBox.address.uuid
        expect((() => barBox.bool.setValue(true))).toThrow()
        expect(scene.editing.modify(() => barBox.bool.setValue(true)).isEmpty()).true
        expect(scene.graph.findBox(barUuid).nonEmpty()).true
        expect(scene.editing.modify(() => barBox.delete()).isEmpty()).true
        expect(scene.graph.findBox(barUuid).nonEmpty()).false
        scene.editing.undo()
        expect(scene.graph.findBox(barUuid).nonEmpty()).true
        scene.editing.undo()
    })

    it("should be undo/redo single steps", (scene: TestScene) => {
        const barBox = scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate())).unwrap()
        const barUuid = barBox.address.uuid
        expect((scene.graph.findBox(barUuid).unwrap().box as BarBox).bool.getValue()).false
        expect(scene.editing.modify(() => barBox.bool.setValue(true)).isEmpty()).true
        expect((scene.graph.findBox(barUuid).unwrap().box as BarBox).bool.getValue()).true
        expect(scene.editing.modify(() => barBox.delete()).isEmpty()).true
        scene.editing.undo()
        expect(scene.graph.findBox(barUuid).nonEmpty()).true
        expect((scene.graph.findBox(barUuid).unwrap().box as BarBox).bool.getValue()).true
        scene.editing.undo()
        expect((scene.graph.findBox(barUuid).unwrap().box as BarBox).bool.getValue()).false
        scene.editing.undo()
        expect(scene.graph.findBox(barUuid).nonEmpty()).false
        scene.editing.redo()
        expect(scene.graph.findBox(barUuid).nonEmpty()).true
        expect((scene.graph.findBox(barUuid).unwrap().box as BarBox).bool.getValue()).false
        scene.editing.redo()
        expect((scene.graph.findBox(barUuid).unwrap().box as BarBox).bool.getValue()).true
        scene.editing.redo()
        expect(scene.graph.findBox(barUuid).nonEmpty()).false
    })

    it("should handle box created and deleted in same transaction", (scene: TestScene) => {
        // In a single transaction: create a box, modify it, and delete it
        scene.editing.modify(() => {
            const tempBox = BarBox.create(scene.graph, UUID.generate())
            tempBox.bool.setValue(true)
            tempBox.delete()
        })
        // The modification should have no visible effect (box created and deleted)
        expect(scene.graph.boxes().length).toBe(0)
        // Undo should work without errors (the phantom box updates are filtered out)
        // Since there's nothing effective to undo, canUndo should be false
        expect(scene.editing.canUndo()).false
    })

    it("should handle multiple boxes created and some deleted in same transaction", (scene: TestScene) => {
        let survivingBox: BarBox | null = null
        let deletedUuid: UUID.Bytes | null = null
        scene.editing.modify(() => {
            // Create two boxes
            const box1 = BarBox.create(scene.graph, UUID.generate())
            const box2 = BarBox.create(scene.graph, UUID.generate())
            box1.bool.setValue(true)
            box2.bool.setValue(true)
            // Delete only one
            deletedUuid = box1.address.uuid
            box1.delete()
            survivingBox = box2
        })
        // The surviving box should exist
        expect(scene.graph.findBox(survivingBox!.address.uuid).nonEmpty()).true
        expect((scene.graph.findBox(survivingBox!.address.uuid).unwrap().box as BarBox).bool.getValue()).true
        // The deleted box should not exist
        expect(scene.graph.findBox(deletedUuid!).nonEmpty()).false
        // Undo should work - removes the surviving box
        expect(() => scene.editing.undo()).not.toThrow()
        expect(scene.graph.findBox(survivingBox!.address.uuid).nonEmpty()).false
        // Redo should restore the surviving box
        expect(() => scene.editing.redo()).not.toThrow()
        expect(scene.graph.findBox(survivingBox!.address.uuid).nonEmpty()).true
    })

    it("should handle box with pointer created and deleted in same transaction", (scene: TestScene) => {
        // Create a target box first (this one persists)
        const targetBox = scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate())).unwrap()
        const targetUuid = targetBox.address.uuid
        // In a single transaction: create a box with a pointer to target, then delete the new box
        scene.editing.modify(() => {
            const tempBox = BarBox.create(scene.graph, UUID.generate())
            // Set the pointer to reference the target box's pointer field (which accepts PointerType.A)
            tempBox.pointer.targetAddress = Option.wrap(targetBox.pointer.address)
            tempBox.delete()
        })
        // Target should still exist (only the temp box was created and deleted)
        expect(scene.graph.findBox(targetUuid).nonEmpty()).true
        // Only target box should exist
        expect(scene.graph.boxes().length).toBe(1)
        // Undo the phantom transaction should work without "Could not find PointerField" error
        // Since the phantom transaction was optimized away, undo goes back to before target was created
        scene.editing.undo()
        expect(scene.graph.findBox(targetUuid).nonEmpty()).false
        // Redo should restore target
        scene.editing.redo()
        expect(scene.graph.findBox(targetUuid).nonEmpty()).true
    })
})