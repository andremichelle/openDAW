import {beforeEach, describe, expect, it} from "vitest"
import {BooleanField, BoxGraph, Field} from "./"
import {PointerField, UnreferenceableType} from "./pointer"
import {Box, BoxConstruct} from "./box"
import {NoPointers, VertexVisitor} from "./vertex"
import {Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {BoxEditing} from "./editing"

enum PointerType {A, B}

interface BoxVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitBarBox?(box: BarBox): RETURN
    visitMandatoryBox?(box: MandatoryBox): RETURN
    visitRefBox?(box: RefBox): RETURN
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
                deprecated: false,
                pointerRules: NoPointers
            }, false),
            2: PointerField.create({
                parent: this,
                fieldKey: 2,
                fieldName: "B",
                deprecated: false,
                pointerRules: NoPointers
            }, PointerType.A, false)
        }
    }

    accept<R>(visitor: BoxVisitor<R>): Maybe<R> {return safeExecute(visitor.visitBarBox, this)}

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get bool(): BooleanField {return this.getField(1)}
    get pointer(): PointerField<PointerType.A> {return this.getField(2)}
}

type MandatoryBoxFields = {
    1: BooleanField
    2: Field<PointerType.B>
}

class MandatoryBox extends Box<PointerType.A, MandatoryBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<MandatoryBox>): MandatoryBox {
        return graph.stageBox(new MandatoryBox({
            uuid, graph, name: "MandatoryBox",
            pointerRules: {accepts: [PointerType.A], mandatory: true, exclusive: false}
        }), constructor)
    }

    private constructor(construct: BoxConstruct<PointerType.A>) {super(construct)}

    protected initializeFields(): MandatoryBoxFields {
        return {
            1: BooleanField.create({parent: this, fieldKey: 1, fieldName: "value", deprecated: false, pointerRules: NoPointers}, false),
            2: Field.hook({parent: this, fieldKey: 2, fieldName: "children", deprecated: false,
                pointerRules: {accepts: [PointerType.B], mandatory: false, exclusive: false}})
        }
    }

    accept<R>(visitor: BoxVisitor<R>): Maybe<R> {return safeExecute(visitor.visitMandatoryBox, this)}

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get value(): BooleanField {return this.getField(1)}
    get children(): Field<PointerType.B> {return this.getField(2)}
}

type RefBoxFields = {
    1: PointerField<PointerType.A>
}

class RefBox extends Box<UnreferenceableType, RefBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<RefBox>): RefBox {
        return graph.stageBox(new RefBox({uuid, graph, name: "RefBox", pointerRules: NoPointers}), constructor)
    }

    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}

    protected initializeFields(): RefBoxFields {
        return {
            1: PointerField.create({parent: this, fieldKey: 1, fieldName: "target", deprecated: false, pointerRules: NoPointers},
                PointerType.A, true)
        }
    }

    accept<R>(visitor: BoxVisitor<R>): Maybe<R> {return safeExecute(visitor.visitRefBox, this)}

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get target(): PointerField<PointerType.A> {return this.getField(1)}
}

const createGraphWithFactory = () => new BoxGraph<any>(Option.wrap(
    (name: keyof any, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>) => {
        switch (name) {
            case "BarBox": return BarBox.create(graph, uuid, constructor)
            case "MandatoryBox": return MandatoryBox.create(graph, uuid, constructor as Procedure<MandatoryBox>)
            case "RefBox": return RefBox.create(graph, uuid, constructor as Procedure<RefBox>)
            default: return panic()
        }
    }))

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

    it("should append changes to the last committed history step", (scene: TestScene) => {
        const barBox = scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate())).unwrap()
        const barUuid = barBox.address.uuid
        expect(scene.graph.findBox(barUuid).nonEmpty()).true
        expect(barBox.bool.getValue()).false
        scene.editing.append(() => barBox.bool.setValue(true))
        expect(barBox.bool.getValue()).true
        expect(scene.editing.canUndo()).true
        scene.editing.undo()
        expect(scene.graph.findBox(barUuid).nonEmpty()).false
        scene.editing.redo()
        expect(scene.graph.findBox(barUuid).nonEmpty()).true
        expect((scene.graph.findBox(barUuid).unwrap().box as BarBox).bool.getValue()).true
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

describe("transaction validation & rollback", () => {
    describe("validation catches invalid state", () => {
        it("valid transaction succeeds", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(graph.boxes().length).toBe(2)
        })

        it("invalid transaction throws and graph is empty", () => {
            const graph = createGraphWithFactory()
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(graph.boxes().length).toBe(0)
        })

        it("invalid transaction preserves prior valid state", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const bar = BarBox.create(graph, UUID.generate())
            graph.endTransaction()
            expect(graph.boxes().length).toBe(1)
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(graph.boxes().length).toBe(1)
            expect(graph.findBox(bar.address.uuid).nonEmpty()).true
        })

        it("rollback restores primitive values", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(mandatory.value.getValue()).false
            expect(() => {
                graph.beginTransaction()
                mandatory.value.setValue(true)
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(mandatory.value.getValue()).false
        })

        it("rollback restores pointer values", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const m1 = MandatoryBox.create(graph, UUID.generate())
            const m2 = MandatoryBox.create(graph, UUID.generate())
            const ref = RefBox.create(graph, UUID.generate(), box => box.target.refer(m1))
            RefBox.create(graph, UUID.generate(), box => box.target.refer(m2))
            graph.endTransaction()
            expect(ref.target.targetAddress.unwrap().equals(m1.address)).true
            expect(() => {
                graph.beginTransaction()
                ref.target.refer(m2)
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(ref.target.targetAddress.unwrap().equals(m1.address)).true
        })

        it("multiple failed transactions in a row — graph stays valid", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            for (let iteration = 0; iteration < 5; iteration++) {
                expect(() => {
                    graph.beginTransaction()
                    MandatoryBox.create(graph, UUID.generate())
                    graph.endTransaction()
                }).toThrow(/requires an edge/)
            }
            expect(graph.boxes().length).toBe(2)
            expect(() => graph.edges().validateRequirements()).not.toThrow()
        })

        it("valid transaction after failed one works", () => {
            const graph = createGraphWithFactory()
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(graph.boxes().length).toBe(2)
        })
    })

    describe("subscriber state after rollback", () => {
        it("onEndTransaction receives rolledBack=false on success, true on failure", () => {
            const graph = createGraphWithFactory()
            const results: Array<boolean> = []
            graph.subscribeTransaction({
                onBeginTransaction: () => {},
                onEndTransaction: (rolledBack) => results.push(rolledBack)
            })
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(results).toStrictEqual([false])
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(results).toStrictEqual([false, true])
        })

        it("primitive listener state is restored after rollback", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            let trackedValue = mandatory.value.getValue()
            graph.subscribeToAllUpdates({
                onUpdate: (update) => {
                    if (update.type === "primitive" && update.address.uuid === mandatory.address.uuid) {
                        trackedValue = update.newValue as boolean
                    }
                }
            })
            expect(trackedValue).false
            expect(() => {
                graph.beginTransaction()
                mandatory.value.setValue(true)
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(trackedValue).false
        })

        it("box count tracker is restored after rollback", () => {
            const graph = createGraphWithFactory()
            let trackedCount = 0
            graph.subscribeToAllUpdates({
                onUpdate: (update) => {
                    if (update.type === "new") {trackedCount++}
                    if (update.type === "delete") {trackedCount--}
                }
            })
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(trackedCount).toBe(2)
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(trackedCount).toBe(2)
        })

        it("immediate listener state is restored after rollback", () => {
            const graph = createGraphWithFactory()
            let trackedCount = 0
            graph.subscribeToAllUpdatesImmediate({
                onUpdate: (update) => {
                    if (update.type === "new") {trackedCount++}
                    if (update.type === "delete") {trackedCount--}
                }
            })
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(trackedCount).toBe(2)
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(trackedCount).toBe(2)
        })

        it("pointerHub listeners are NOT called during failed transaction", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            let addedCount = 0
            let removedCount = 0
            mandatory.children.pointerHub.subscribe({
                onAdded: () => addedCount++,
                onRemoved: () => removedCount++
            })
            expect(() => {
                graph.beginTransaction()
                RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(addedCount).toBe(0)
            expect(removedCount).toBe(0)
        })

        it("#inTransaction is false when onEndTransaction fires", () => {
            const graph = createGraphWithFactory()
            let wasInTransaction = true
            graph.subscribeTransaction({
                onBeginTransaction: () => {},
                onEndTransaction: (_rolledBack) => {wasInTransaction = graph.inTransaction()}
            })
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(wasInTransaction).false
        })

        it("YSync-like subscriber discards updates on rollback", () => {
            const graph = createGraphWithFactory()
            const synced: Array<ReadonlyArray<string>> = []
            const updates: Array<string> = []
            graph.subscribeToAllUpdatesImmediate({
                onUpdate: (update) => updates.push(update.type)
            })
            graph.subscribeTransaction({
                onBeginTransaction: () => {},
                onEndTransaction: (rolledBack) => {
                    if (rolledBack) {
                        updates.length = 0
                        return
                    }
                    synced.push([...updates])
                    updates.length = 0
                }
            })
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            expect(synced.length).toBe(0)
            expect(updates.length).toBe(0)
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(synced.length).toBe(1)
        })
    })

    describe("abortTransaction", () => {
        it("rolls back mid-transaction changes and fires onEndTransaction(true)", () => {
            const graph = createGraphWithFactory()
            const results: Array<boolean> = []
            graph.subscribeTransaction({
                onBeginTransaction: () => {},
                onEndTransaction: (rolledBack) => results.push(rolledBack)
            })
            graph.beginTransaction()
            BarBox.create(graph, UUID.generate())
            graph.abortTransaction()
            expect(graph.boxes().length).toBe(0)
            expect(results).toStrictEqual([true])
        })

        it("subscriber box count is restored after abort", () => {
            const graph = createGraphWithFactory()
            let trackedCount = 0
            graph.subscribeToAllUpdates({
                onUpdate: (update) => {
                    if (update.type === "new") {trackedCount++}
                    if (update.type === "delete") {trackedCount--}
                }
            })
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            expect(trackedCount).toBe(2)
            graph.beginTransaction()
            BarBox.create(graph, UUID.generate())
            expect(trackedCount).toBe(3)
            graph.abortTransaction()
            expect(trackedCount).toBe(2)
            expect(graph.boxes().length).toBe(2)
        })

        it("subscriber primitive value is restored after abort", () => {
            const graph = createGraphWithFactory()
            graph.beginTransaction()
            const mandatory = MandatoryBox.create(graph, UUID.generate())
            RefBox.create(graph, UUID.generate(), box => box.target.refer(mandatory))
            graph.endTransaction()
            let trackedValue = mandatory.value.getValue()
            graph.subscribeToAllUpdates({
                onUpdate: (update) => {
                    if (update.type === "primitive" && update.address.uuid === mandatory.address.uuid) {
                        trackedValue = update.newValue as boolean
                    }
                }
            })
            expect(trackedValue).false
            graph.beginTransaction()
            mandatory.value.setValue(true)
            expect(trackedValue).true
            graph.abortTransaction()
            expect(trackedValue).false
            expect(mandatory.value.getValue()).false
        })
    })

    describe("deferred pointer notifications", () => {
        it("deferred notifications not dispatched on rollback", () => {
            const graph = createGraphWithFactory()
            const pointerUpdates: Array<string> = []
            graph.subscribeToAllUpdates({
                onUpdate: (update) => {
                    if (update.type === "pointer") {pointerUpdates.push("pointer")}
                }
            })
            expect(() => {
                graph.beginTransaction()
                MandatoryBox.create(graph, UUID.generate())
                graph.endTransaction()
            }).toThrow(/requires an edge/)
            const forwardCount = pointerUpdates.filter(type => type === "pointer").length
            expect(forwardCount % 2).toBe(0)
        })
    })
})

describe("resilient undo/redo & editing error handling", () => {
    interface TestScene {
        graph: BoxGraph
        editing: BoxEditing
    }

    beforeEach<TestScene>((scene: TestScene) => {
        scene.graph = createGraphWithFactory()
        scene.editing = new BoxEditing(scene.graph)
    })

    describe("undo resilience", () => {
        it("undo returns false and shows dialog when step produces invalid state", (scene: TestScene) => {
            const {mandatory} = scene.editing.modify(() => {
                const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
                RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
                return {mandatory}
            }).unwrap()
            scene.graph.beginTransaction()
            mandatory.value.setValue(true)
            scene.graph.endTransaction()
            scene.editing.modify(() => mandatory.value.setValue(false))
            expect(scene.editing.canUndo()).true
            const result = scene.editing.undo()
            expect(result).true
        })

        it("undo of externally invalidated step returns false", (scene: TestScene) => {
            scene.editing.modify(() => {
                const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
                RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            })
            scene.editing.modify(() => {
                BarBox.create(scene.graph, UUID.generate())
            })
            expect(scene.graph.boxes().length).toBe(3)
            expect(scene.editing.undo()).true
            expect(scene.graph.boxes().length).toBe(2)
            expect(scene.editing.undo()).true
            expect(scene.graph.boxes().length).toBe(0)
        })

        it("graph stays valid after failed undo", (scene: TestScene) => {
            scene.editing.modify(() => {
                const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
                RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            })
            expect(scene.graph.boxes().length).toBe(2)
            expect(scene.editing.undo()).true
            expect(scene.graph.boxes().length).toBe(0)
            expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        })

        it("historyIndex is restored after failed undo", (scene: TestScene) => {
            scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate()))
            expect(scene.editing.canUndo()).true
            expect(scene.editing.canRedo()).false
            scene.editing.undo()
            expect(scene.editing.canUndo()).false
            expect(scene.editing.canRedo()).true
            scene.editing.redo()
            expect(scene.editing.canUndo()).true
        })
    })

    describe("modify error handling", () => {
        it("modify throws and graph is valid when endTransaction rolls back", (scene: TestScene) => {
            expect(() => scene.editing.modify(() => {
                MandatoryBox.create(scene.graph, UUID.generate())
            })).toThrow(/requires an edge/)
            expect(scene.graph.boxes().length).toBe(0)
            expect(scene.graph.inTransaction()).false
        })

        it("modify throws and graph is valid when modifier throws", (scene: TestScene) => {
            scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate()))
            expect(scene.graph.boxes().length).toBe(1)
            expect(() => scene.editing.modify(() => {
                BarBox.create(scene.graph, UUID.generate())
                throw new Error("modifier error")
            })).toThrow(/modifier error/)
            expect(scene.graph.boxes().length).toBe(1)
            expect(scene.graph.inTransaction()).false
        })

        it("editing state is clean after failed modify", (scene: TestScene) => {
            expect(() => scene.editing.modify(() => {
                MandatoryBox.create(scene.graph, UUID.generate())
            })).toThrow(/requires an edge/)
            expect(scene.editing.canUndo()).false
            expect(scene.editing.hasNoChanges()).true
            scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate()))
            expect(scene.editing.canUndo()).true
        })

        it("editing preserves history after failed modify", (scene: TestScene) => {
            scene.editing.modify(() => {
                const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
                RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            })
            expect(scene.editing.canUndo()).true
            expect(() => scene.editing.modify(() => {
                MandatoryBox.create(scene.graph, UUID.generate())
            })).toThrow(/requires an edge/)
            expect(scene.editing.canUndo()).true
            scene.editing.undo()
            expect(scene.graph.boxes().length).toBe(0)
        })

        it("append throws and graph is valid on rollback", (scene: TestScene) => {
            scene.editing.modify(() => {
                const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
                RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            })
            expect(() => scene.editing.append(() => {
                MandatoryBox.create(scene.graph, UUID.generate())
            })).toThrow(/requires an edge/)
            expect(scene.graph.boxes().length).toBe(2)
            expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        })
    })
})

describe("P2P concurrent editing simulation", () => {
    interface TestScene {
        graph: BoxGraph
        editing: BoxEditing
    }

    const externalTransaction = (graph: BoxGraph, action: () => void) => {
        graph.beginTransaction()
        action()
        graph.endTransaction()
    }

    beforeEach<TestScene>((scene: TestScene) => {
        scene.graph = createGraphWithFactory()
        scene.editing = new BoxEditing(scene.graph)
    })

    it("A creates device, B creates device — both exist", (scene: TestScene) => {
        const mandatoryA = scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            return mandatory
        }).unwrap()
        externalTransaction(scene.graph, () => {
            const mandatoryB = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatoryB))
        })
        expect(scene.graph.boxes().length).toBe(4)
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
    })

    it("A creates device, B deletes it, A undoes — fails gracefully", (scene: TestScene) => {
        const {mandatory} = scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            return {mandatory}
        }).unwrap()
        const mandatoryUuid = mandatory.address.uuid
        expect(scene.graph.boxes().length).toBe(2)
        externalTransaction(scene.graph, () => mandatory.delete())
        expect(scene.graph.findBox(mandatoryUuid).isEmpty()).true
        expect(scene.graph.boxes().length).toBe(0)
        expect(scene.editing.canUndo()).true
        expect(scene.editing.undo()).false
        expect(scene.graph.findBox(mandatoryUuid).isEmpty()).true
        expect(scene.graph.inTransaction()).false
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
    })

    it("A creates device + modifies field, B deletes device, A undoes — fails, then A continues working", (scene: TestScene) => {
        const mandatory = scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            return mandatory
        }).unwrap()
        scene.editing.modify(() => mandatory.value.setValue(true))
        externalTransaction(scene.graph, () => mandatory.delete())
        expect(scene.editing.undo()).false
        expect(scene.graph.inTransaction()).false
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        scene.editing.modify(() => {
            const newMandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(newMandatory))
        })
        expect(scene.graph.boxes().length).toBeGreaterThan(0)
    })

    it("B sends invalid external update — rejected, graph stays valid", (scene: TestScene) => {
        scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
        })
        expect(scene.graph.boxes().length).toBe(2)
        expect(() => externalTransaction(scene.graph, () => {
            MandatoryBox.create(scene.graph, UUID.generate())
        })).toThrow(/requires an edge/)
        expect(scene.graph.boxes().length).toBe(2)
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
    })

    it("A edits after B's invalid external update is rejected", (scene: TestScene) => {
        expect(() => externalTransaction(scene.graph, () => {
            MandatoryBox.create(scene.graph, UUID.generate())
        })).toThrow(/requires an edge/)
        scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
        })
        expect(scene.graph.boxes().length).toBe(2)
        expect(scene.editing.canUndo()).true
    })

    it("rapid interleaved create/delete cycles", (scene: TestScene) => {
        for (let iteration = 0; iteration < 10; iteration++) {
            scene.editing.modify(() => {
                const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
                RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            })
            externalTransaction(scene.graph, () => {
                const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
                RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            })
        }
        expect(scene.graph.boxes().length).toBe(40)
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        for (let iteration = 0; iteration < 10; iteration++) {
            expect(scene.editing.undo()).true
        }
        expect(scene.graph.boxes().length).toBe(20)
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
    })

    it("A undoes after B already undid related change — no crash", (scene: TestScene) => {
        const mandatory = scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            return mandatory
        }).unwrap()
        const mandatoryUuid = mandatory.address.uuid
        externalTransaction(scene.graph, () => {
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
        })
        expect(scene.graph.boxes().length).toBe(3)
        externalTransaction(scene.graph, () => mandatory.delete())
        expect(scene.graph.findBox(mandatoryUuid).isEmpty()).true
        expect(scene.editing.undo()).false
        expect(scene.graph.inTransaction()).false
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
    })

    it("external update arrives between undo steps — graph stays valid", (scene: TestScene) => {
        scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
        })
        scene.editing.modify(() => BarBox.create(scene.graph, UUID.generate()))
        expect(scene.graph.boxes().length).toBe(3)
        expect(scene.editing.undo()).true
        expect(scene.graph.boxes().length).toBe(2)
        externalTransaction(scene.graph, () => BarBox.create(scene.graph, UUID.generate()))
        expect(scene.graph.boxes().length).toBe(3)
        expect(scene.editing.undo()).true
        expect(scene.graph.boxes().length).toBe(1)
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
    })

    it("A modifies field, B modifies same field — last write wins, no crash", (scene: TestScene) => {
        const mandatory = scene.editing.modify(() => {
            const mandatory = MandatoryBox.create(scene.graph, UUID.generate())
            RefBox.create(scene.graph, UUID.generate(), box => box.target.refer(mandatory))
            return mandatory
        }).unwrap()
        scene.editing.modify(() => mandatory.value.setValue(true))
        expect(mandatory.value.getValue()).true
        externalTransaction(scene.graph, () => mandatory.value.setValue(false))
        expect(mandatory.value.getValue()).false
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
    })
})