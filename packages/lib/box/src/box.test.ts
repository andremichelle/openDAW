import {ByteArrayInput, ByteArrayOutput, Maybe, Option, safeExecute, Unhandled, UUID} from "@moises-ai/lib-std"
import {NoPointers, VertexVisitor} from "./vertex"
import {Field, FieldConstruct} from "./field"
import {Box, BoxConstruct} from "./box"
import {BooleanField, ByteArrayField, Float32Field, Int32Field, PrimitiveField, StringField} from "./primitive"
import {PointerField, UnreferenceableType} from "./pointer"
import {BoxGraph} from "./graph"
import {ArrayField} from "./array"
import {ObjectField} from "./object"
import {Propagation} from "./dispatchers"
import {describe, expect, it, vi} from "vitest"

enum PointerType {"A", "B", "C"}

interface BoxVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitFooBox?(box: FooBox): RETURN
    visitBarBox?(box: BarBox): RETURN
}

type FooBoxFields = {
    0: Field<PointerType.A>
    1: FooObject
    2: PointerField<PointerType.A>
    3: ArrayField<BooleanField<PointerType.A>>
    4: ArrayField<FooObject>
    5: ArrayField<PointerField<PointerType.A>>
}

class FooBox extends Box<PointerType.C, FooBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes): FooBox {
        return graph.stageBox(new FooBox({
            uuid, graph: graph, name: "FooBox", pointerRules: {
                accepts: [PointerType.C],
                mandatory: true
            }
        }))
    }

    private constructor(construct: BoxConstruct<PointerType.C>) {super(construct)}

    protected initializeFields(): FooBoxFields {
        return {
            0: Field.hook({
                parent: this,
                fieldKey: 0,
                fieldName: "0",
                pointerRules: {accepts: [PointerType.A], mandatory: false}
            }),
            1: new FooObject({
                parent: this,
                fieldKey: 1,
                fieldName: "1",
                pointerRules: NoPointers
            }),
            2: PointerField.create({
                parent: this,
                fieldKey: 2,
                fieldName: "2",
                pointerRules: NoPointers
            }, PointerType.A, false),
            3: ArrayField.create({
                parent: this,
                fieldKey: 3,
                fieldName: "3",
                pointerRules: NoPointers
            }, construct => BooleanField.create({
                ...construct,
                pointerRules: {mandatory: false, accepts: [PointerType.A]}
            }), 9),
            4: ArrayField.create({
                parent: this,
                fieldKey: 4,
                fieldName: "4",
                pointerRules: NoPointers
            }, construct => new FooObject(construct), 9),
            5: ArrayField.create({
                parent: this,
                fieldKey: 5,
                fieldName: "5",
                pointerRules: NoPointers
            }, construct => PointerField.create(construct, PointerType.A, false), 9)
        }
    }

    accept<R>(visitor: BoxVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitFooBox, this)
    }

    get bas(): Field {return this.getField(0)}
    get foo(): FooObject {return this.getField(1)}
    get ref(): PointerField<PointerType.A> {return this.getField(2)}
    get booleans(): ArrayField<BooleanField<PointerType.A>> {return this.getField(3)}
    get foos(): ArrayField<FooObject> {return this.getField(4)}
    get points(): ArrayField<PointerField<PointerType.A>> {return this.getField(5)}
}

export namespace BoxIO {
    export interface TypeMap {
        "FooBox": FooBox
        "BarBox": BarBox
    }

    export const create = <K extends keyof TypeMap, V extends TypeMap[K]>(type: K, graph: BoxGraph, uuid: UUID.Bytes): V => {
        switch (type) {
            case "FooBox":
                return FooBox.create(graph, uuid) as V
            case "BarBox":
                return BarBox.create(graph, uuid) as V
            default:
                return Unhandled(type)
        }
    }

    export const deserialize = (graph: BoxGraph, buffer: ArrayBufferLike): Box => {
        const stream = new ByteArrayInput(buffer)
        stream.readInt()
        const className = stream.readString() as keyof TypeMap
        const uuidBytes = UUID.fromDataInput(stream)
        const box = create(className, graph, uuidBytes)
        box.read(stream)
        return box
    }
}

type BarBoxFields = {
    2: PointerField<PointerType.C>
}

class BarBox extends Box<UnreferenceableType, BarBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes): BarBox {
        return graph.stageBox(new BarBox({
            uuid,
            graph: graph,
            name: "BarBox",
            pointerRules: NoPointers
        }))
    }

    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}

    protected initializeFields(): BarBoxFields {
        return {
            2: PointerField.create({
                parent: this,
                fieldKey: 2,
                fieldName: "2",
                pointerRules: NoPointers
            }, PointerType.C, false)
        }
    }

    accept<RETURN>(visitor: BoxVisitor<RETURN>): Maybe<RETURN> {
        return safeExecute(visitor.visitBarBox, this)
    }

    get ref(): PointerField<PointerType.C> {return this.getField(2)}
}

type FooObjectFields = {
    0: BooleanField<PointerType.B>
    1: PrimitiveField<string, PointerType.A>
    2: Float32Field
    3: Int32Field<PointerType.B | PointerType.A>
    4: ByteArrayField
}

class FooObject extends ObjectField<FooObjectFields> {
    constructor(construct: FieldConstruct<UnreferenceableType>) {
        super(construct)
    }

    protected initializeFields(): FooObjectFields {
        return {
            0: BooleanField.create({
                parent: this,
                fieldKey: 0,
                fieldName: "0",
                pointerRules: {accepts: [PointerType.B], mandatory: true}
            }),
            1: StringField.create({
                parent: this,
                fieldKey: 1,
                fieldName: "1",
                pointerRules: {accepts: [PointerType.A], mandatory: true}
            }),
            2: Float32Field.create({
                parent: this,
                fieldKey: 2,
                fieldName: "2",
                pointerRules: {accepts: [], mandatory: true}
            }, Math.PI),
            3: Int32Field.create({
                parent: this,
                fieldKey: 3,
                fieldName: "3",
                pointerRules: {accepts: [PointerType.A, PointerType.B], mandatory: true}
            }),
            4: ByteArrayField.create({
                parent: this,
                fieldKey: 4,
                fieldName: "4",
                pointerRules: {accepts: [], mandatory: false}
            }, new Int8Array([1, 2, 3]))
        }
    }

    get mute(): BooleanField<PointerType.B> {return this.getField(0)}
    get solo(): PrimitiveField<string, PointerType.A> {return this.getField(1)}
    get bar(): PrimitiveField<number> {return this.getField(2)}
    get baz(): PrimitiveField<number, PointerType.B | PointerType.A> {return this.getField(3)}
}

describe("gen (create/navigate)", () => {
    const graph: BoxGraph = new BoxGraph()
    graph.beginTransaction()
    const fooBox = FooBox.create(graph, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
    const barBox = BarBox.create(graph, UUID.parse("41424300-0000-4000-8000-000000000000"))
    graph.endTransaction()

    it("visitor", () => expect(fooBox.accept({visitFooBox: (_: FooBox): boolean => true})).true)
    it("visitor", () => expect(fooBox.accept({visitBarBox: (_: BarBox): boolean => true})).undefined)

    it("isAttached", () => expect(fooBox.foo.solo.isAttached()).true)
    it("isAttached", () => expect(barBox.ref.isAttached()).true)
    it("print optField(0) path", () => expect(fooBox.optField(0).mapOr((f: Field) => f.address.toString(), ""))
        .toBe("3372511f-fab0-4dcd-a723-0146c949a527/0"))
    it("print fooBox.bas path", () => expect(fooBox.bas.address.toString())
        .toBe("3372511f-fab0-4dcd-a723-0146c949a527/0"))
    it("print fooBox path", () => expect(fooBox.address.toString())
        .toBe("3372511f-fab0-4dcd-a723-0146c949a527"))
    it("print fooBox.bas.box.address path", () => expect(fooBox.bas.box.address.toString())
        .toBe("3372511f-fab0-4dcd-a723-0146c949a527"))
    it("find field", () => expect(fooBox.searchVertex(new Int16Array([1, 3])).contains(fooBox.foo.baz)).true)
    it("find box", () => expect(fooBox.foo.solo.box).toBe(fooBox))
    it("getField(1)", () => expect(fooBox.foo.getField(1)).toBe(fooBox.foo.solo))
    it("share graph", () => expect(fooBox.foo.solo.graph).toBe(graph))
    // @ts-expect-error
    it("incompatible", () => expect(() => fooBox.ref.refer(fooBox.foo.mute)).toThrow())
    // @ts-expect-error
    it("incompatible", () => expect(() => fooBox.ref.refer(fooBox.foo.bar)).toThrow())
    // it("compatible", () => expect(() => barBox.ref.refer(fooBox)).not.toThrow())
    // it("compatible", () => expect(() => fooBox.ref.refer(fooBox.foo.baz)).not.toThrow())
    // it("compatible", () => expect(() => fooBox.ref.refer(fooBox.foo.solo)).not.toThrow())
    it("collect pointers", () => {
        barBox.ref.targetAddress = Option.None
        fooBox.ref.targetAddress = Option.None
        expect(fooBox.incomingEdges().length).toBe(0)
        graph.beginTransaction()
        barBox.ref.refer(fooBox)
        graph.endTransaction()
        expect(fooBox.incomingEdges()[0]).toBe(barBox.ref)
        graph.beginTransaction()
        barBox.ref.targetAddress = Option.None
        graph.endTransaction()
        expect(fooBox.incomingEdges().length).toBe(0)
        graph.beginTransaction()
        barBox.ref.refer(fooBox)
        expect(barBox.outgoingEdges()[0]).toStrictEqual([barBox.ref, fooBox.ref.address])
        graph.endTransaction()
    })
    it("isDetached after deletion", () => {
        graph.beginTransaction()
        fooBox.delete()
        graph.endTransaction()
        expect(fooBox.foo.solo.isAttached()).false
    })
})

describe("gen (deletion)", () => {
    it("deletion", () => {
        const graph: BoxGraph = new BoxGraph()
        graph.beginTransaction()
        const fooBox = FooBox.create(graph, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        const barBox = BarBox.create(graph, UUID.parse("41424300-0000-4000-8000-000000000000"))
        graph.endTransaction()
        expect(barBox.ref.isAttached()).true
        expect(fooBox.foo.solo.isAttached()).true
        graph.beginTransaction()
        barBox.ref.refer(fooBox)
        graph.endTransaction()
        expect(Array.from(graph.dependenciesOf(barBox).boxes)).toStrictEqual([fooBox])
        graph.beginTransaction()
        barBox.delete()
        graph.endTransaction()
        expect(barBox.ref.isAttached()).false
        expect(fooBox.foo.solo.isAttached()).false
    })
})

describe("ArrayField", () => {
    it("expect update event", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const fooBox = FooBox.create(graph, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        graph.endTransaction()
        const mockCallback = vi.fn()
        const subscription = graph.subscribeVertexUpdates(Propagation.Children, fooBox.address, mockCallback)
        graph.beginTransaction()
        fooBox.booleans.getField(4).setValue(true)
        fooBox.booleans.getField(5).setValue(true)
        fooBox.booleans.getField(6).setValue(true)
        graph.endTransaction()
        expect(mockCallback).toBeCalledTimes(3)
        subscription.terminate()
    })
    it("set object property", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const fooBox = FooBox.create(graph, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        graph.endTransaction()
        const mockCallback = vi.fn()
        const subscription = graph.subscribeVertexUpdates(Propagation.Children, fooBox.address, mockCallback)
        expect(fooBox.foos.getField(0).baz.getValue()).toBe(0)
        graph.beginTransaction()
        fooBox.foos.getField(0).baz.setValue(41)
        fooBox.foos.getField(0).baz.setValue(42)
        graph.endTransaction()
        expect(fooBox.foos.getField(0).baz.getValue()).toBe(42)
        expect(mockCallback).toBeCalledTimes(2)
        subscription.terminate()
    })
    it("pointers", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const fooBox = FooBox.create(graph, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        graph.endTransaction()
        expect(fooBox.booleans.getField(0).pointerHub.nonEmpty()).false
        expect(fooBox.ref.nonEmpty()).false
        graph.beginTransaction()
        fooBox.ref.refer(fooBox.booleans.getField(0))
        graph.endTransaction()
        expect(fooBox.ref.nonEmpty()).true
        expect(fooBox.booleans.getField(0).pointerHub.nonEmpty()).true

        const $0 = fooBox.points.getField(0)
        expect($0.isEmpty()).true
        expect(fooBox.foo.solo.pointerHub.isEmpty()).true
        graph.beginTransaction()
        $0.refer(fooBox.foo.solo)
        graph.endTransaction()
        expect(fooBox.foo.solo.pointerHub.isEmpty()).false
        expect(fooBox.foo.solo.pointerHub.size()).toBe(1)
        graph.beginTransaction()
        $0.refer(fooBox.foo.solo)
        graph.endTransaction()
        expect(fooBox.foo.solo.pointerHub.isEmpty()).false
        expect(fooBox.foo.solo.pointerHub.size()).toBe(1)
        expect($0.isEmpty()).false
        graph.beginTransaction()
        $0.defer()
        graph.endTransaction()
        expect($0.isEmpty()).true
        expect(fooBox.foo.solo.pointerHub.isEmpty()).true
        expect(fooBox.foo.solo.pointerHub.size()).toBe(0)
    })
    it("fields bytes io", () => {
        const graphA = new BoxGraph()
        graphA.beginTransaction()
        const template = FooBox.create(graphA, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        template.booleans.getField(4).setValue(true)
        template.foo.solo.setValue("Hello 👻")
        template.foos.getField(3).baz.setValue(42)
        graphA.endTransaction()
        const output = ByteArrayOutput.create()
        template.write(output)
        const graphB = new BoxGraph()
        graphB.beginTransaction()
        const recreation = FooBox.create(graphB, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        graphB.endTransaction()
        expect(recreation.booleans.getField(4).getValue()).false
        expect(recreation.foo.solo.getValue()).toBe("")
        expect(recreation.foos.getField(3).baz.getValue()).toBe(0)
        graphB.beginTransaction()
        recreation.read(new ByteArrayInput(output.toArrayBuffer()))
        graphB.endTransaction()
        expect(recreation.booleans.getField(4).getValue()).true
        expect(recreation.foo.solo.getValue()).toBe("Hello 👻")
        expect(recreation.foos.getField(3).baz.getValue()).toBe(42)
    })
    it("fields json io", () => {
        const graphA = new BoxGraph()
        graphA.beginTransaction()
        const template = FooBox.create(graphA, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        template.booleans.getField(4).setValue(true)
        template.foo.solo.setValue("Hello 👻")
        template.foos.getField(3).baz.setValue(42)
        graphA.endTransaction()
        const json = JSON.stringify(template.toJSON())
        const graphB = new BoxGraph()
        graphB.beginTransaction()
        const recreation = FooBox.create(graphB, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        graphB.endTransaction()
        expect(recreation.booleans.getField(4).getValue()).false
        expect(recreation.foo.solo.getValue()).toBe("")
        expect(recreation.foos.getField(3).baz.getValue()).toBe(0)
        graphB.beginTransaction()
        recreation.fromJSON(JSON.parse(json))
        graphB.endTransaction()
        expect(recreation.booleans.getField(4).getValue()).true
        expect(recreation.foo.solo.getValue()).toBe("Hello 👻")
        expect(recreation.foos.getField(3).baz.getValue()).toBe(42)
    })
    it("box io", () => {
        const boxGraphA = new BoxGraph()
        boxGraphA.beginTransaction()
        const template = FooBox.create(boxGraphA, UUID.parse("3372511f-fab0-4dcd-a723-0146c949a527"))
        template.booleans.getField(4).setValue(true)
        template.foo.solo.setValue("Hello 👻")
        template.foos.getField(3).baz.setValue(42)
        boxGraphA.endTransaction()
        const boxGraphB = new BoxGraph()
        boxGraphB.beginTransaction()
        const recreation = BoxIO.deserialize(boxGraphB, template.serialize()) as FooBox
        boxGraphB.endTransaction()
        expect(recreation.booleans.getField(4).getValue()).true
        expect(recreation.foo.solo.getValue()).toBe("Hello 👻")
        expect(recreation.foos.getField(3).baz.getValue()).toBe(42)
    })
})