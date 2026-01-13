import {Field, FieldConstruct} from "./field"
import {UnreferenceableType} from "./pointer"
import {
    Arrays,
    asDefined,
    DataInput,
    DataOutput,
    int,
    JSONValue,
    Maybe,
    Option,
    Optional,
    panic,
    safeExecute
} from "@moises-ai/lib-std"
import {NoPointers, VertexVisitor} from "./vertex"

export type ArrayFieldFactory<FIELD extends Field> = (construct: FieldConstruct<UnreferenceableType>) => FIELD

export class ArrayField<FIELD extends Field = Field>
    extends Field<UnreferenceableType, Record<int, FIELD>> {
    static create<FIELD extends Field>(
        construct: FieldConstruct<UnreferenceableType>,
        factory: ArrayFieldFactory<FIELD>,
        length: int): ArrayField<FIELD> {
        return new ArrayField<FIELD>(construct, factory, length)
    }
    readonly #fields: ReadonlyArray<FIELD>

    private constructor(construct: FieldConstruct<UnreferenceableType>, factory: ArrayFieldFactory<FIELD>, length: int) {
        super(construct)

        this.#fields = Arrays.create((index: int) => factory({
            parent: this,
            fieldKey: index,
            fieldName: String(index),
            pointerRules: NoPointers,
            deprecated: construct.deprecated
        }), length)
    }

    accept<RETURN>(visitor: VertexVisitor<RETURN>): Maybe<RETURN> {
        return safeExecute(visitor.visitArrayField, this)
    }

    fields(): ReadonlyArray<FIELD> {return this.#fields}
    record(): Readonly<Record<string, Field>> {
        return Arrays.toRecord(this.#fields, field => String(field.fieldKey))
    }

    getField(key: keyof Record<int, FIELD>): Record<int, FIELD>[keyof Record<int, FIELD>] {
        return asDefined(this.#fields[key])
    }

    optField(key: keyof Record<int, FIELD>): Option<Record<int, FIELD>[keyof Record<int, FIELD>]> {
        return Option.wrap(this.#fields[key])
    }

    read(input: DataInput): void {this.#fields.forEach(field => field.read(input))}

    write(output: DataOutput): void {
        this.#fields.filter(field => !field.deprecated)
            .forEach(field => field.write(output))
    }

    size(): int {return this.#fields.length}

    toJSON(): Optional<JSONValue> {
        if (this.deprecated) {return undefined}
        return Object.values(this.#fields).map((field) => field.toJSON() ?? null)
    }

    fromJSON(values: JSONValue): void {
        if (this.deprecated) {return}
        if (Array.isArray(values)) {
            values.forEach((value, index) => this.#fields[index].fromJSON(value))
        } else {
            return panic("Type mismatch")
        }
    }
}