import {describe, expect, it} from "vitest"
import {BoxGraph, Int32Field, ObjectField, StringField} from "./"
import {Box, BoxConstruct} from "./box"
import {NoPointers, VertexVisitor} from "./vertex"
import {UnreferenceableType} from "./pointer"
import {FieldConstruct} from "./field"
import {applyUpdateTasks} from "./sync-target"
import {PrimitiveType} from "./primitive"
import {ByteArrayInput, ByteArrayOutput, Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"

type OldFields = { 1: StringField }

class Old extends ObjectField<OldFields> {
    static create(construct: FieldConstruct<UnreferenceableType>): Old {return new Old(construct)}

    protected initializeFields(): OldFields {
        return {1: StringField.create({parent: this, fieldKey: 1, fieldName: "id", deprecated: false, pointerRules: NoPointers})}
    }
}

type LegacyBoxFields = { 1: Int32Field, 2: Int32Field, 3: Old }

// One live field, one deprecated field and a deprecated object holding a field that is not flagged itself.
class LegacyBox extends Box<UnreferenceableType, LegacyBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<LegacyBox>): LegacyBox {
        return graph.stageBox(new LegacyBox({uuid, graph, name: "LegacyBox", pointerRules: NoPointers}), constructor)
    }

    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}

    protected initializeFields(): LegacyBoxFields {
        return {
            1: Int32Field.create({parent: this, fieldKey: 1, fieldName: "live", deprecated: false, pointerRules: NoPointers},
                {min: 0, max: 100}, "", 0),
            2: Int32Field.create({parent: this, fieldKey: 2, fieldName: "chance", deprecated: true, pointerRules: NoPointers},
                {min: 0, max: 100}, "", 100),
            3: Old.create({parent: this, fieldKey: 3, fieldName: "old", deprecated: true, pointerRules: NoPointers})
        }
    }

    accept<R>(visitor: VertexVisitor<R>): Maybe<R> {return safeExecute(undefined, this)}

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get live(): Int32Field {return this.getField(1)}
    get chance(): Int32Field {return this.getField(2)}
    get old(): Old {return this.getField(3)}
}

const createGraph = () => new BoxGraph(Option.wrap((name: keyof any, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>) =>
    name === "LegacyBox" ? LegacyBox.create(graph, uuid, constructor as Procedure<LegacyBox>) : panic()))

describe("deprecated primitive fields", () => {
    it("throw on a write, also while the box is constructed", () => {
        const graph = createGraph()
        graph.beginTransaction()
        const box = LegacyBox.create(graph, UUID.generate())
        expect(() => box.chance.setValue(50)).toThrow(/deprecated/)
        expect(() => box.chance.setValue(100)).toThrow(/deprecated/)
        expect(() => box.old.getField(1).setValue("port")).toThrow(/deprecated/)
        expect(() => LegacyBox.create(graph, UUID.generate(), created => created.chance.setValue(50))).toThrow(/deprecated/)
        box.live.setValue(50)
        graph.endTransaction()
        expect(box.live.getValue()).toBe(50)
        expect(box.chance.getValue()).toBe(100)
    })

    it("still load the value an old project stored", () => {
        // An old project stored the deprecated field, loading reads it from these bytes while constructing the box.
        const output = ByteArrayOutput.create()
        output.writeInt(30)
        const graph = createGraph()
        graph.beginTransaction()
        const stored = LegacyBox.create(graph, UUID.generate(),
            box => box.chance.read(new ByteArrayInput(output.toArrayBuffer())))
        graph.endTransaction()
        expect(stored.chance.getValue()).toBe(30)
    })

    it("can be cleared by a migration", () => {
        const graph = createGraph()
        graph.beginTransaction()
        const box = LegacyBox.create(graph, UUID.generate())
        const output = ByteArrayOutput.create()
        output.writeString("port")
        box.old.getField(1).read(new ByteArrayInput(output.toArrayBuffer()))
        box.old.getField(1).writeDeprecated("")
        graph.endTransaction()
        expect(box.old.getField(1).getValue()).toBe("")
        expect(() => box.live.writeDeprecated(0)).toThrow(/not deprecated/)
    })

    it("are mirrored by sync, which only sends what a migration wrote", () => {
        const graph = createGraph()
        graph.beginTransaction()
        const box = LegacyBox.create(graph, UUID.generate())
        applyUpdateTasks(graph, [{
            type: "update-primitive", address: box.chance.address.decompose(),
            primitiveType: PrimitiveType.Int32, value: 40
        }])
        graph.endTransaction()
        expect(box.chance.getValue()).toBe(40)
    })
})
