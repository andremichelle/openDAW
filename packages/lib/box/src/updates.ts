import {PrimitiveField, PrimitiveType, PrimitiveValues, ValueSerialization} from "./primitive"
import {Address} from "./address"
import {PointerField} from "./pointer"
import {Arrays, ByteArrayInput, DataInput, DataOutput, Option, UUID} from "@moises-ai/lib-std"
import {BoxGraph} from "./graph"

export type Update = NewUpdate | PrimitiveUpdate | PointerUpdate | DeleteUpdate

export namespace Updates {
    export const decode = (input: DataInput): ReadonlyArray<Update> => {
        const numBlocks = input.readInt()
        return Arrays.create(() => {
            const type = input.readString() as Update["type"]
            switch (type) {
                case "new": {
                    const uuid = UUID.fromDataInput(input)
                    const name = input.readString()
                    const settings = new Int8Array(input.readInt())
                    input.readBytes(settings)
                    return new NewUpdate(uuid, name, settings.buffer)
                }
                case "pointer": {
                    const address = Address.read(input)
                    const oldAddress = input.readBoolean() ? Option.wrap(Address.read(input)) : Option.None
                    const newAddress = input.readBoolean() ? Option.wrap(Address.read(input)) : Option.None
                    return new PointerUpdate(address, oldAddress, newAddress)
                }
                case "primitive": {
                    const address = Address.read(input)
                    const type: PrimitiveType = input.readString() as PrimitiveType
                    const serializer: ValueSerialization = ValueSerialization[type]
                    const oldValue = serializer.decode(input)
                    const newValue = serializer.decode(input)
                    return new PrimitiveUpdate(address, serializer, oldValue, newValue)
                }
                case "delete": {
                    const uuid = UUID.fromDataInput(input)
                    const name = input.readString()
                    const settings = new Int8Array(input.readInt())
                    input.readBytes(settings)
                    return new DeleteUpdate(uuid, name, settings.buffer)
                }
            }
        }, numBlocks)
    }
}

interface Modification {
    forward(graph: BoxGraph): void
    inverse(graph: BoxGraph): void
    write(output: DataOutput): void
}

export class NewUpdate implements Modification {
    readonly type = "new"

    readonly #uuid: UUID.Bytes
    readonly #name: string
    readonly #settings: ArrayBufferLike

    constructor(uuid: UUID.Bytes, name: string, settings: ArrayBufferLike) {
        this.#uuid = uuid
        this.#name = name
        this.#settings = settings
    }

    get uuid(): UUID.Bytes {return this.#uuid}
    get name(): string {return this.#name}
    get settings(): ArrayBufferLike {return this.#settings}

    forward(graph: BoxGraph): void {
        graph.createBox(this.#name, this.#uuid, box => box.read(new ByteArrayInput(this.#settings)))
    }

    inverse(graph: BoxGraph): void {
        graph.findBox(this.#uuid).unwrap(() => `Could not find ${this.#name}`).unstage()
    }

    write(output: DataOutput): void {
        output.writeString(this.type)
        UUID.toDataOutput(output, this.#uuid)
        output.writeString(this.#name)
        output.writeInt(this.#settings.byteLength)
        output.writeBytes(new Int8Array(this.#settings))
    }

    toString(): string {
        return `{NewUpdate uuid: ${UUID.toString(this.#uuid)}, attachment: ${this.settings.byteLength}b`
    }

    toDebugString(_graph: BoxGraph): string {return this.toString()}
}

export type FieldUpdate = PrimitiveUpdate | PointerUpdate

export class PrimitiveUpdate<V extends PrimitiveValues = PrimitiveValues> implements Modification {
    readonly type = "primitive"

    readonly #address: Address
    readonly #serialization: ValueSerialization<V>
    readonly #oldValue: V
    readonly #newValue: V

    constructor(address: Address, serialization: ValueSerialization<V>, oldValue: V, newValue: V) {
        this.#address = address
        this.#serialization = serialization
        this.#oldValue = oldValue
        this.#newValue = newValue
    }

    get address(): Address {return this.#address}
    get oldValue(): V {return this.#oldValue}
    get newValue(): V {return this.#newValue}

    matches(field: PrimitiveField): boolean {return field.address.equals(this.address)}

    inverse(graph: BoxGraph): void {this.field(graph).setValue(this.#oldValue)}
    forward(graph: BoxGraph): void {this.field(graph).setValue(this.#newValue)}

    field(graph: BoxGraph): PrimitiveField<V> {
        return graph.findVertex(this.#address)
            .unwrap(() => `Could not find PrimitiveField at ${this.#address}`) as PrimitiveField<V>
    }

    write(output: DataOutput): void {
        output.writeString(this.type)
        this.#address.write(output)
        output.writeString(this.#serialization.type)
        this.#serialization.encode(output, this.#oldValue)
        this.#serialization.encode(output, this.#newValue)
    }

    toString(): string {
        return `{PrimitiveUpdate oldValue: ${this.#oldValue}, newValue: ${this.#newValue}`
    }
}

export class PointerUpdate implements Modification {
    readonly type = "pointer"

    readonly #address: Address
    readonly #oldAddress: Option<Address>
    readonly #newAddress: Option<Address>

    constructor(address: Address, oldAddress: Option<Address>, newAddress: Option<Address>) {
        this.#address = address
        this.#oldAddress = oldAddress
        this.#newAddress = newAddress
    }

    get address(): Address {return this.#address}
    get oldAddress(): Option<Address> {return this.#oldAddress}
    get newAddress(): Option<Address> {return this.#newAddress}

    matches(field: PointerField): boolean {return field.address.equals(this.address)}

    inverse(graph: BoxGraph): void {this.field(graph).targetAddress = this.#oldAddress}
    forward(graph: BoxGraph): void {this.field(graph).targetAddress = this.#newAddress}

    field(graph: BoxGraph): PointerField {
        return graph.findVertex(this.#address)
            .unwrap(() => `Could not find PointerField at ${this.#address}`) as PointerField
    }

    write(output: DataOutput): void {
        output.writeString(this.type)
        this.#address.write(output)
        this.#oldAddress.match({
            none: () => output.writeBoolean(false),
            some: address => {
                output.writeBoolean(true)
                address.write(output)
            }
        })
        this.#newAddress.match({
            none: () => output.writeBoolean(false),
            some: address => {
                output.writeBoolean(true)
                address.write(output)
            }
        })
    }

    toString(): string {
        return `{PointerUpdate oldValue: ${this.#oldAddress.unwrapOrNull()}, newValue: ${this.#newAddress.unwrapOrNull()}`
    }
}

export class DeleteUpdate implements Modification {
    readonly type = "delete"

    readonly #uuid: UUID.Bytes
    readonly #name: string
    readonly #settings: ArrayBufferLike

    constructor(uuid: UUID.Bytes, name: string, settings: ArrayBufferLike) {
        this.#uuid = uuid
        this.#name = name
        this.#settings = settings
    }

    get uuid(): UUID.Bytes {return this.#uuid}
    get name(): string {return this.#name}
    get settings(): ArrayBufferLike {return this.#settings}

    forward(graph: BoxGraph): void {
        graph.findBox(this.#uuid).unwrap(() => `Could not find ${this.#name}`).unstage()
    }

    inverse(graph: BoxGraph): void {
        graph.createBox(this.#name, this.#uuid, box => box.read(new ByteArrayInput(this.#settings)))
    }

    write(output: DataOutput): void {
        output.writeString(this.type)
        UUID.toDataOutput(output, this.#uuid)
        output.writeString(this.#name)
        output.writeInt(this.#settings.byteLength)
        output.writeBytes(new Int8Array(this.#settings))
    }

    toString(): string {
        return `{DeleteUpdate uuid: ${UUID.toString(this.#uuid)}, attachment: ${this.settings.byteLength}b`
    }
}