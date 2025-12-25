import {Address} from "./address"
import {
    Arrays,
    asDefined,
    asInstanceOf,
    ByteArrayOutput,
    ByteCounter,
    Class,
    DataInput,
    DataOutput,
    Func,
    int,
    isDefined,
    isRecord,
    JSONValue,
    Lazy,
    Maybe,
    Option,
    Optional,
    panic,
    Procedure,
    Subscription,
    UUID
} from "@opendaw/lib-std"
import {PointerRules, Vertex, VertexVisitor} from "./vertex"
import {Field, FieldKey, FieldKeys, Fields} from "./field"
import {PointerField, PointerTypes} from "./pointer"
import {PointerHub} from "./pointer-hub"
import {Serializer} from "./serializer"
import {BoxGraph} from "./graph"
import {Update} from "./updates"
import {Propagation} from "./dispatchers"
import {ArrayField} from "./array"
import {ObjectField} from "./object"
import {PrimitiveField} from "./primitive"

export type BoxConstruct<T extends PointerTypes> = {
    uuid: UUID.Bytes
    graph: BoxGraph
    name: string
    pointerRules: PointerRules<T>
}

export abstract class Box<P extends PointerTypes = PointerTypes, F extends Fields = any> implements Vertex<P, F> {
    static readonly DEBUG_DELETION = false

    static Index: int = 0 | 0

    readonly #address: Address
    readonly #graph: BoxGraph
    readonly #name: string
    readonly #pointerRules: PointerRules<P>

    readonly #fields: F
    readonly #creationIndex = Box.Index++

    protected constructor({uuid, graph, name, pointerRules}: BoxConstruct<P>) {
        this.#address = Address.compose(uuid)
        this.#graph = graph
        this.#name = name
        this.#pointerRules = pointerRules

        this.#fields = this.initializeFields()

        if (pointerRules.mandatory) {this.graph.edges().watchVertex(this)}
    }

    protected abstract initializeFields(): F

    abstract accept<VISITOR extends VertexVisitor<any>>(visitor: VISITOR): VISITOR extends VertexVisitor<infer R> ? Maybe<R> : void

    fields(): ReadonlyArray<Field> {return Object.values(this.#fields)}
    record(): Readonly<Record<string, Field>> {return this.#fields}
    getField<K extends keyof F>(key: K): F[K] {
        return asDefined(this.#fields[key],
            () => `Field ${String(key)} not found in ${this.toString()}`)
    }
    optField<K extends keyof F>(key: K): Option<F[K]> {return Option.wrap(this.#fields[key])}
    subscribe(propagation: Propagation, procedure: Procedure<Update>): Subscription {
        return this.graph.subscribeVertexUpdates(propagation, this.address, procedure)
    }

    get box(): Box {return this}
    get name(): string {return this.#name}
    get graph(): BoxGraph {return this.#graph}
    get parent(): Vertex {return this}
    get address(): Address {return this.#address}
    get pointerRules(): PointerRules<P> {return this.#pointerRules}
    get creationIndex(): number {return this.#creationIndex}

    @Lazy
    get pointerHub(): PointerHub {return new PointerHub(this)}

    estimateMemory(): int {
        const byteCounter = new ByteCounter()
        this.write(byteCounter)
        return byteCounter.count
    }

    isBox(): this is Box {return true}
    asBox<T extends Box>(type: Class<T>): T {return asInstanceOf(this, type)}
    isField(): this is Field {return false}
    isAttached(): boolean {return this.#graph.findBox(this.address.uuid).nonEmpty()}
    read(input: DataInput): void {Serializer.readFields(input, this.#fields)}
    write(output: DataOutput): void {Serializer.writeFields(output, this.#fields)}
    serialize(): ArrayBufferLike {
        const output = ByteArrayOutput.create()
        output.writeInt(this.#creationIndex) // allows to re-load the boxes in the same order as created
        output.writeString(this.name)
        output.writeBytes(new Int8Array(this.address.uuid.buffer))
        this.write(output)
        return output.toArrayBuffer()
    }
    toArrayBuffer(): ArrayBufferLike {
        const output = ByteArrayOutput.create()
        this.write(output)
        return output.toArrayBuffer()
    }
    toJSON(): Optional<JSONValue> {
        return Object.entries(this.#fields).reduce((result: Record<string, Optional<JSONValue>>, [key, field]) => {
            const value = field.toJSON()
            if (isDefined(value)) {
                result[key] = value
            }
            return result
        }, {})
    }
    fromJSON(record: JSONValue): void {
        if (isRecord(record)) {
            Object.entries(record).forEach(([key, value]) => {
                const field: Field = this.#fields[parseInt(key) as FieldKey]
                if (isDefined(value)) {
                    field.fromJSON(value)
                }
            })
        } else {
            return panic("Type mismatch")
        }
    }

    incomingEdges(): ReadonlyArray<PointerField> {return this.graph.edges().incomingEdgesOf(this)}
    outgoingEdges(): ReadonlyArray<[PointerField, Address]> {return this.graph.edges().outgoingEdgesOf(this)}

    mapFields<T>(map: Func<Field, T>, ...keys: ReadonlyArray<FieldKey>): ReadonlyArray<T> {
        if (keys.length === 0) {return Arrays.empty()}
        let parent: Field = this.getField(keys[0])
        const result: Array<T> = [map(parent)]
        for (let index: int = 1; index < keys.length; index++) {
            parent = parent.getField(keys[index])
            result.push(map(parent))
        }
        return result
    }

    searchVertex(keys: FieldKeys): Option<Vertex> {
        if (keys.length === 0) {return Option.wrap(this)}
        let parent: Option<Field> = this.optField(keys[0])
        if (parent.isEmpty()) {return Option.None}
        for (let index: int = 1; index < keys.length; index++) {
            parent = parent.unwrap().optField(keys[index])
            if (parent.isEmpty()) {return Option.None}
        }
        return parent
    }

    delete(): void {
        if (!this.isAttached()) {return}
        const {boxes, pointers} = this.graph.dependenciesOf(this)
        if (Box.DEBUG_DELETION) {
            console.debug(`Delete ${this.toString()}`)
            console.debug("\tunplugs", [...pointers].map(x => x.toString()).join("\n"))
            console.debug("\tunstages", [...boxes].map(x => x.toString()).join("\n"), this)
        }
        for (const pointer of pointers) {pointer.defer()}
        for (const box of boxes) {box.unstage()}
        this.unstage()
    }

    unstage(): void {this.graph.unstageBox(this)}

    isValid(): boolean {
        if (this.#pointerRules.mandatory && this.pointerHub.incoming().length === 0) {
            return false
        }
        const walkRecursive = (fields: ReadonlyArray<Field>): boolean =>
            fields.every(field => field.accept<boolean>({
                visitPointerField: (field: PointerField) => !field.mandatory || field.nonEmpty(),
                visitArrayField: (field: ArrayField) => walkRecursive(field.fields()),
                visitObjectField: (field: ObjectField<any>) => walkRecursive(field.fields()),
                visitPrimitiveField: (_field: PrimitiveField) => true,
                visitField: (_field: Field): boolean => true
            }) ?? true)
        return walkRecursive(this.fields())
    }

    toString(): string {return `${this.constructor.name} ${this.address.toString()}`}
}