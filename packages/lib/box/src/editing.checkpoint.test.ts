import {beforeEach, describe, expect, it} from "vitest"
import {BooleanField, BoxGraph} from "./"
import {Box, BoxConstruct} from "./box"
import {NoPointers, VertexVisitor} from "./vertex"
import {UnreferenceableType} from "./pointer"
import {Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {BoxEditing} from "./editing"

type FlagBoxFields = { 1: BooleanField }

class FlagBox extends Box<UnreferenceableType, FlagBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<FlagBox>): FlagBox {
        return graph.stageBox(new FlagBox({uuid, graph, name: "FlagBox", pointerRules: NoPointers}), constructor)
    }

    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}

    protected initializeFields(): FlagBoxFields {
        return {1: BooleanField.create({parent: this, fieldKey: 1, fieldName: "flag", deprecated: false, pointerRules: NoPointers}, false)}
    }

    accept<R>(visitor: VertexVisitor<R>): Maybe<R> {return safeExecute(undefined, this)}

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get flag(): BooleanField {return this.getField(1)}
}

describe("editing checkpoint", () => {
    interface Scene {
        graph: BoxGraph
        editing: BoxEditing
    }

    beforeEach<Scene>((scene: Scene) => {
        scene.graph = new BoxGraph(Option.wrap((name: keyof any, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>) =>
            name === "FlagBox" ? FlagBox.create(graph, uuid, constructor as Procedure<FlagBox>) : panic()))
        scene.editing = new BoxEditing(scene.graph)
    })

    const create = ({graph, editing}: Scene, mark: boolean = true): FlagBox =>
        editing.modify(() => FlagBox.create(graph, UUID.generate()), mark).unwrap()

    it("rolls back pending changes", (scene: Scene) => {
        const checkpoint = scene.editing.checkpoint()
        create(scene, false)
        create(scene, false)
        expect(scene.graph.boxes().length).toBe(2)
        checkpoint.rollback()
        expect(scene.graph.boxes().length).toBe(0)
        expect(scene.editing.canUndo()).false
    })

    it("rolls back marked steps without leaving a redo", (scene: Scene) => {
        const kept = create(scene)
        const checkpoint = scene.editing.checkpoint()
        create(scene)
        scene.editing.modify(() => kept.flag.setValue(true))
        checkpoint.rollback()
        expect(scene.graph.boxes().length).toBe(1)
        expect(kept.flag.getValue()).false
        expect(scene.editing.canRedo()).false
        scene.editing.undo()
        expect(scene.graph.boxes().length).toBe(0)
    })

    it("rolls back changes appended to the step before the checkpoint", (scene: Scene) => {
        const kept = create(scene)
        const checkpoint = scene.editing.checkpoint()
        scene.editing.append(() => kept.flag.setValue(true))
        checkpoint.rollback()
        expect(kept.flag.getValue()).false
        scene.editing.undo()
        expect(scene.graph.boxes().length).toBe(0)
        scene.editing.redo()
        expect((scene.graph.boxes()[0] as FlagBox).flag.getValue()).false
    })

    it("keeps an existing redo when only pending changes are rolled back", (scene: Scene) => {
        create(scene)
        scene.editing.undo()
        const checkpoint = scene.editing.checkpoint()
        create(scene, false)
        checkpoint.rollback()
        expect(scene.graph.boxes().length).toBe(0)
        expect(scene.editing.canRedo()).true
    })

    it("commits pending, marked and appended changes as one step", (scene: Scene) => {
        const kept = create(scene)
        const checkpoint = scene.editing.checkpoint()
        scene.editing.append(() => kept.flag.setValue(true))
        create(scene)
        create(scene, false)
        checkpoint.commit()
        expect(scene.graph.boxes().length).toBe(3)
        scene.editing.undo()
        expect(scene.graph.boxes().length).toBe(1)
        expect(kept.flag.getValue()).false
        scene.editing.undo()
        expect(scene.graph.boxes().length).toBe(0)
        scene.editing.redo()
        scene.editing.redo()
        expect(scene.graph.boxes().length).toBe(3)
        expect((scene.graph.findBox(kept.address.uuid).unwrap() as FlagBox).flag.getValue()).true
    })

    it("seals pending changes from before the checkpoint", (scene: Scene) => {
        create(scene)
        create(scene, false)
        const checkpoint = scene.editing.checkpoint()
        create(scene, false)
        checkpoint.rollback()
        expect(scene.graph.boxes().length).toBe(2)
        scene.editing.undo()
        expect(scene.graph.boxes().length).toBe(0)
    })

    it("commits nothing without changes and settles once", (scene: Scene) => {
        create(scene)
        const checkpoint = scene.editing.checkpoint()
        checkpoint.commit()
        checkpoint.rollback()
        expect(scene.graph.boxes().length).toBe(1)
        scene.editing.undo()
        expect(scene.editing.canUndo()).false
    })

    it("marks the project unsaved when the saved step is rolled away", (scene: Scene) => {
        create(scene)
        const checkpoint = scene.editing.checkpoint()
        create(scene)
        scene.editing.markSaved()
        checkpoint.rollback()
        expect(scene.editing.hasUnsavedChanges()).true
    })

    it("ignores a checkpoint after the history was cleared", (scene: Scene) => {
        const checkpoint = scene.editing.checkpoint()
        create(scene)
        scene.editing.clear()
        checkpoint.rollback()
        expect(scene.graph.boxes().length).toBe(1)
    })
})
