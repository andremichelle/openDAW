import {
    Arrays,
    DataInput,
    DataOutput,
    JSONValue,
    Lazy,
    Maybe,
    Objects,
    Option,
    Optional,
    panic,
    safeExecute,
    short
} from "@opendaw/lib-std"
import {Address} from "./address"
import {Box} from "./box"
import {PointerRules, Vertex, VertexVisitor} from "./vertex"
import {PointerTypes} from "./pointer"
import {PointerHub} from "./pointer-hub"
import {BoxGraph} from "./graph"

export type FieldKey = number // i16 should be enough for larger arrays
export type FieldKeys = Readonly<Int16Array>
export type Fields = Record<FieldKey, Field>
export type FieldConstruct<T extends PointerTypes> = {
    parent: Vertex
    fieldKey: FieldKey
    fieldName: string
    pointerRules: PointerRules<T>
    deprecated: boolean
}

export class Field<P extends PointerTypes = PointerTypes, F extends Fields = Fields> implements Vertex<P, F> {
    static hook<P extends PointerTypes>(construct: FieldConstruct<P>) {
        return new Field<P>(construct)
    }

    readonly #parent: Vertex
    readonly #fieldKey: short
    readonly #fieldName: string
    readonly #pointerRules: PointerRules<P>
    readonly #deprecated: boolean

    protected constructor({parent, fieldKey, fieldName, pointerRules, deprecated}: FieldConstruct<P>) {
        this.#parent = parent
        this.#fieldKey = fieldKey
        this.#fieldName = fieldName
        this.#pointerRules = pointerRules
        this.#deprecated = deprecated

        if (pointerRules.mandatory || pointerRules.exclusive) {this.graph.edges().watchVertex(this)}
    }

    accept<RETURN>(visitor: VertexVisitor<RETURN>): Maybe<RETURN> {
        return safeExecute(visitor.visitField, this as Field)
    }

    get box(): Box {return this.#parent.box}
    get graph(): BoxGraph {return this.#parent.graph}
    get parent(): Vertex {return this.#parent}
    get fieldKey(): short {return this.#fieldKey}
    get fieldName(): string {return this.#fieldName}
    get pointerRules(): PointerRules<P> {return this.#pointerRules}
    get deprecated(): boolean {return this.#deprecated}

    @Lazy
    get pointerHub(): PointerHub {return new PointerHub(this)}

    @Lazy
    get address(): Address {return this.#parent.address.append(this.#fieldKey)}

    @Lazy
    get debugPath(): string {
        return `${this.box.name}:${this.box.mapFields(field => field.fieldName, ...this.address.fieldKeys).join("/")}`
    }

    isBox(): this is Box {return false}
    isField(): this is Field {return true}
    isAttached(): boolean {return this.graph.findBox(this.address.uuid).nonEmpty()}
    fields(): ReadonlyArray<Field> {return Arrays.empty()}
    record(): Record<string, Field> {return Objects.empty()}
    getField(_key: keyof F): F[keyof F] {return panic()}
    optField(_key: keyof F): Option<F[keyof F]> {return Option.None}
    read(_input: DataInput): void {}
    write(_output: DataOutput): void {}
    toJSON(): Optional<JSONValue> {return undefined}
    fromJSON(_value: JSONValue): void {return panic("fromJSON should never be called on a field")}
    disconnect(): void {
        if (this.pointerHub.isEmpty()) {return}
        const incoming = this.pointerHub.incoming()
        incoming.forEach(pointer => {
            pointer.defer()
            if (pointer.mandatory || (this.pointerRules.mandatory && incoming.length === 1)) {
                console.warn(`[Field.disconnect] Deleting ${pointer.box} because pointer.mandatory=${pointer.mandatory} or (field.mandatory=${this.pointerRules.mandatory} and lastPointer=${incoming.length === 1})`)
                pointer.box.delete()
            }
        })
    }
    toString(): string {return `{${this.box.constructor.name}:${this.constructor.name} (${this.fieldName}) ${this.address.toString()}`}
}