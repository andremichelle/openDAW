import {
    assert,
    DataInput,
    DataOutput,
    isNull,
    JSONValue,
    Maybe,
    Observer,
    Option,
    Optional,
    panic,
    Procedure,
    Provider,
    safeExecute,
    Subscription,
    tryCatch
} from "@moises-ai/lib-std"
import {Vertex, VertexVisitor} from "./vertex"
import {Address} from "./address"
import {PointerHub} from "./pointer-hub"
import {Field, FieldConstruct} from "./field"
import {Propagation} from "./dispatchers"

const _Unreferenceable = Symbol("Unreferenceable")

export type UnreferenceableType = typeof _Unreferenceable

export type PointerTypes = number | string | UnreferenceableType

export interface SpecialEncoder {map(pointer: PointerField): Option<Address>}

export interface SpecialDecoder {map(pointer: PointerField, newAddress: Option<Address>): Option<Address>}

export class PointerField<P extends PointerTypes = PointerTypes> extends Field<UnreferenceableType, never> {
    static create<P extends PointerTypes>(construct: FieldConstruct<UnreferenceableType>,
                                          pointerType: P,
                                          mandatory: boolean): PointerField<P> {
        return new PointerField<P>(construct, pointerType, mandatory)
    }

    static encodeWith<R>(encoder: SpecialEncoder, exec: Provider<R>): R {
        assert(this.#encoder.isEmpty(), "SerializationEncoder already in use")
        this.#encoder = Option.wrap(encoder)
        const result = tryCatch(exec)
        this.#encoder = Option.None
        if (result.status === "failure") {
            throw result.error
        }
        return result.value
    }

    static decodeWith<R>(decoder: SpecialDecoder, exec: Provider<R>): R {
        assert(this.#decoder.isEmpty(), "SerializationDecoder already in use")
        this.#decoder = Option.wrap(decoder)
        const result = tryCatch(exec)
        this.#decoder = Option.None
        if (result.status === "failure") {
            throw result.error
        }
        return result.value
    }

    static #encoder: Option<SpecialEncoder> = Option.None
    static #decoder: Option<SpecialDecoder> = Option.None

    readonly #pointerType: P
    readonly #mandatory: boolean

    #targetVertex: Option<Vertex> = Option.None
    #targetAddress: Option<Address> = Option.None

    private constructor(field: FieldConstruct<UnreferenceableType>, pointerType: P, mandatory: boolean) {
        super(field)

        this.#pointerType = pointerType
        this.#mandatory = mandatory

        if (mandatory) {this.graph.edges().watchVertex(this)}
    }

    get pointerHub(): PointerHub {return panic(`${this} cannot be pointed to`)}

    get pointerType(): P {return this.#pointerType}
    get mandatory(): boolean {return this.#mandatory}

    accept<RETURN>(visitor: VertexVisitor<RETURN>): Maybe<RETURN> {
        return safeExecute(visitor.visitPointerField, this as PointerField)
    }

    subscribe(observer: Observer<this>): Subscription {
        return this.graph.subscribeVertexUpdates(Propagation.This, this.address,
            () => this.graph.subscribeEndTransaction(() => observer(this)))
    }

    catchupAndSubscribe(observer: Observer<this>): Subscription {
        observer(this)
        return this.subscribe(observer)
    }

    refer<TARGET extends PointerTypes>(vertex: Vertex<P & TARGET extends never ? never : TARGET>): void {
        this.targetVertex = Option.wrap(vertex)
    }

    defer(): void {this.targetVertex = Option.None}

    get targetVertex(): Option<Vertex> {
        return this.graph.inTransaction()
            ? this.#targetAddress.flatMap((address: Address) => this.graph.findVertex(address))
            : this.#targetVertex
    }
    set targetVertex(option: Option<Vertex>) {
        if (option.nonEmpty()) {
            const issue = PointerHub.validate(this, option.unwrap())
            if (issue.nonEmpty()) {
                panic(issue.unwrap())
            }
        }
        this.targetAddress = option.map(vertex => vertex.address)
    }

    get targetAddress(): Option<Address> {return this.#targetAddress}
    set targetAddress(newValue: Option<Address>) {
        const oldValue = this.#targetAddress
        if ((oldValue.isEmpty() && newValue.isEmpty())
            || (newValue.nonEmpty() && oldValue.unwrapOrNull()?.equals(newValue.unwrap())) === true) {return}
        this.#targetAddress = newValue
        this.graph.onPointerAddressUpdated(this, oldValue, newValue)
    }

    isEmpty(): boolean {return this.targetAddress.isEmpty()}
    nonEmpty(): boolean {return this.targetAddress.nonEmpty()}
    ifVertex(procedure: Procedure<Vertex>): void {
        if (this.targetVertex.nonEmpty()) {procedure(this.targetVertex.unwrap())}
    }

    resolvedTo(newTarget: Option<Vertex>): void {this.#targetVertex = newTarget}

    read(input: DataInput) {
        const address = input.readBoolean()
            ? Option.wrap(Address.read(input))
            : Option.None
        this.targetAddress = PointerField.#decoder.match({
            none: () => address,
            some: decoder => decoder.map(this, address)
        })
    }

    write(output: DataOutput) {
        assert(!this.deprecated, "PointerField.write: deprecated field")
        PointerField.#encoder.match({
            none: () => this.#targetAddress,
            some: encoder => encoder.map(this)
        }).match({
            none: () => output.writeBoolean(false),
            some: address => {
                output.writeBoolean(true)
                address.write(output)
            }
        })
    }

    toJSON(): Optional<JSONValue> {
        if (this.deprecated) {return undefined}
        return PointerField.#encoder
            .match({
                none: () => this.#targetAddress,
                some: encoder => encoder.map(this)
            }).match({
                none: () => null,
                some: address => address.toString()
            })
    }

    fromJSON(value: JSONValue): void {
        if (this.deprecated) {return}
        if (isNull(value) || typeof value === "string") {
            const address = Option.wrap(isNull(value) ? null : Address.decode(value))
            this.targetAddress = PointerField.#decoder.match({
                none: () => address,
                some: decoder => decoder.map(this, address)
            })
        } else {
            return panic(`Pointer at (${this.address}) has type mismatch. value (${value}) must be a string, but is ${typeof value}.`)
        }
    }
}