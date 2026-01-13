import {
    Arrays,
    assert,
    BinarySearch,
    Comparable,
    Comparator,
    DataInput,
    DataOutput,
    Func,
    int,
    Nullable,
    SortedSet,
    UUID
} from "@moises-ai/lib-std"
import {FieldKey, FieldKeys} from "./field"

export type AddressJSON = { uuid: Array<int>, fields: Array<int> }
export type AddressLayout = [UUID.Bytes, FieldKeys]

export class Address implements Comparable<Address> {
    static newSet<T>(keyExtractor: Func<T, Address>) {
        return new SortedSet<Address, T>(keyExtractor, Address.Comparator)
    }
    static readonly compose = (uuid: UUID.Bytes, ...fieldKeys: FieldKey[]): Address => {
        const keys = fieldKeys.length === 0 ? this.#EMPTY_FIELD_KEYS : new Int16Array(fieldKeys)
        assert(keys.every((value, index): boolean => value === fieldKeys[index]),
            `fieldKeys (${keys.join(",")}) only allows i16`)
        return new Address(uuid, keys)
    }
    static decode(str: string): Address {
        const parts = str.split("/")
        assert(parts.length > 0, "Unable to parse Address")
        return Address.compose(UUID.parse(parts[0]), ...parts.slice(1).map(x => parseInt(x)))
    }
    static reconstruct(layout: AddressLayout): Address {return this.compose(layout[0], ...layout[1])}
    static boxRange<T>(set: SortedSet<Address, T>, id: UUID.Bytes, map: Func<T, UUID.Bytes>): Nullable<[int, int]> {
        const sorted: ReadonlyArray<T> = set.values()
        const startIndex: int = BinarySearch.leftMostMapped(sorted, id, UUID.Comparator, map)
        const length = sorted.length
        if (startIndex < 0 || startIndex >= length) {
            return null
        }
        for (let endIndex: int = startIndex; endIndex < length; endIndex++) {
            if (UUID.Comparator(map(sorted[endIndex]), id) !== 0) {
                if (startIndex < endIndex) {
                    return [startIndex, endIndex]
                } else {
                    return null
                }
            }
        }
        return [startIndex, length]
    }
    static readonly Comparator: Comparator<Address> = (a: Address, b: Address): int => {
        const compareId = UUID.Comparator(a.#uuid, b.#uuid)
        if (compareId !== 0) {return compareId}
        const n: int = Math.min(a.#fieldKeys.length, b.#fieldKeys.length)
        for (let i: int = 0; i < n; i++) {
            const comparison: int = (a.#fieldKeys)[i] - (b.#fieldKeys)[i]
            if (comparison !== 0) {return comparison}
        }
        return a.#fieldKeys.length - b.#fieldKeys.length
    }
    static readonly MinimalComparator: Comparator<Address> = (a: Address, b: Address): int => {
        const compareId = UUID.Comparator(a.#uuid, b.#uuid)
        if (compareId !== 0) {return compareId}
        const n: int = Math.min(a.#fieldKeys.length, b.#fieldKeys.length)
        for (let i: int = 0; i < n; i++) {
            const comparison: int = (a.#fieldKeys)[i] - (b.#fieldKeys)[i]
            if (comparison !== 0) {return comparison}
        }
        return 0
    }
    static readonly LengthComparator: Comparator<Address> = (a: Address, b: Address): int => {
        const compareId = UUID.Comparator(a.#uuid, b.#uuid)
        if (compareId !== 0) {return compareId}
        return b.#fieldKeys.length - a.#fieldKeys.length
    }

    static readonly #EMPTY_FIELD_KEYS = new Int16Array(0)

    readonly #uuid: UUID.Bytes
    readonly #fieldKeys: FieldKeys

    constructor(uuid: UUID.Bytes, fieldKeys: FieldKeys) {
        this.#uuid = uuid
        this.#fieldKeys = fieldKeys
    }

    get uuid(): UUID.Bytes {return this.#uuid}
    get fieldKeys(): FieldKeys {return this.#fieldKeys}

    isBox(): boolean {return this.#fieldKeys.length === 0}
    isContent(): boolean {return !this.isBox()}
    equals(other: Address): boolean {return Address.Comparator(this, other) === 0}
    compareTo(other: Address): int {return Address.Comparator(this, other)}
    append(key: FieldKey): Address {
        return new Address(this.#uuid, new Int16Array([...this.#fieldKeys, key]))
    }
    startsWith(other: Address): boolean {
        return UUID.Comparator(other.#uuid, this.#uuid) === 0
            && other.#fieldKeys.length <= this.#fieldKeys.length
            && other.#fieldKeys.every((value: int, index: int): boolean => this.#fieldKeys[index] === value)
    }
    write(output: DataOutput): void {
        output.writeBytes(new Int8Array(this.#uuid.buffer))
        output.writeByte(this.#fieldKeys.length)
        this.#fieldKeys.forEach(key => output.writeShort(key))
    }
    moveTo(target: UUID.Bytes): Address {return new Address(target, this.#fieldKeys)}
    decompose(): AddressLayout {return [this.#uuid, this.#fieldKeys]}
    toJSON() {return {uuid: Array.from(this.#uuid.values()), fields: Array.from(this.#fieldKeys.values())}}
    toArrayBuffer(): ArrayBufferLike {
        const array = new Uint8Array(UUID.length + this.#fieldKeys.length)
        array.set(this.#uuid, 0)
        array.set(this.#fieldKeys, UUID.length)
        return array.buffer
    }
    toString(): string {return [UUID.toString(this.#uuid), ...this.#fieldKeys].join("/")}

    static read(input: DataInput): Address {
        const uuidBytes = UUID.fromDataInput(input)
        const numFields = input.readByte()
        return Address.compose(uuidBytes, ...Arrays.create(() => input.readShort(), numFields))
    }
}

export interface Addressable {get address(): Address}

export namespace Addressable {
    export const AddressReader = (addressable: Addressable) => addressable.address
    export const Comparator: Comparator<Addressable> =
        ({address: a}: Addressable, {address: b}: Addressable): int => Address.Comparator(a, b)
    export const equals = <A extends Addressable>(address: Address, sorted: ReadonlyArray<A>): Array<A> => {
        const [l, r] = BinarySearch.rangeMapped(sorted, address, Address.Comparator, Addressable.AddressReader)
        return sorted.slice(l, r + 1)
    }
    export const startsWith = <A extends Addressable>(address: Address, sorted: ReadonlyArray<A>): Array<A> => {
        const [l, r] = BinarySearch.rangeMapped(sorted, address, Address.MinimalComparator, Addressable.AddressReader)
        return sorted
            .slice(l, r + 1)
            .filter((addressable: A) => addressable.address.startsWith(address))
    }
    export const endsWith = <A extends Addressable>(address: Address, sorted: ReadonlyArray<A>): Array<A> => {
        const l: int = BinarySearch.leftMostMapped(sorted, address, Address.LengthComparator, Addressable.AddressReader)
        const r: int = BinarySearch.rightMostMapped(sorted, address, Address.MinimalComparator, Addressable.AddressReader)
        return sorted
            .slice(l, r + 1)
            .filter((addressable: A) => address.startsWith(addressable.address))
    }
}

export class AddressIdEncoder {
    readonly #ids: SortedSet<Address, { address: Address, id: string }>
    #idCount: int

    constructor() {
        this.#ids = Address.newSet(({address}) => address)
        this.#idCount = 0
    }

    getOrCreate(address: Address): string {
        return `id${this.#ids.getOrCreate(address, () => ({address, id: `${++this.#idCount}`})).id}`
    }
}