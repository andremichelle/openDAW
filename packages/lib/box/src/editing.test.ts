import {beforeEach, describe, expect, it} from "vitest"
import {BooleanField, BoxGraph} from "./"
import {PointerField, UnreferenceableType} from "./pointer"
import {Box, BoxConstruct} from "./box"
import {NoPointers, VertexVisitor} from "./vertex"
import {Maybe, Option, panic, Procedure, safeExecute, UUID} from "@moises-ai/lib-std"
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
})