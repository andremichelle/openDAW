import {byte, double, Equality, float, int, panic, short} from "./lang"
import {nextPowOf2} from "./math"
import {Float, Float64} from "./numeric"
import {Iterables} from "./iterables"

export interface DataOutput {
    writeByte(value: byte): void
    writeShort(value: short): void
    writeInt(value: int): void
    writeLong(value: bigint): void
    writeFloat(value: float): void
    writeDouble(value: double): void
    writeBoolean(value: boolean): void
    writeBytes(bytes: Int8Array): void
    writeString(value: string): void
}

export interface DataInput {
    readByte(): byte
    readShort(): short
    readInt(): int
    readLong(): bigint
    readFloat(): float
    readDouble(): double
    readBoolean(): boolean
    readBytes(array: Int8Array): void
    readString(): string
    skip(count: int): void
}

// WASM CONTRACT: the byte layout written here (big-endian primitives, 1-byte booleans, int
// code-unit count + UTF-16 BE strings, raw byte arrays) is mirrored by Rust (crates/boxgraph bytes.rs).
export class ByteArrayOutput implements DataOutput {
    static create(initialCapacity: int = 1024): ByteArrayOutput {
        return this.use(new ArrayBuffer(initialCapacity))
    }

    static use(buffer: ArrayBufferLike, byteOffset: int = 0 | 0): ByteArrayOutput {
        return new ByteArrayOutput(new DataView(buffer, byteOffset))
    }

    littleEndian: boolean = false

    #view: DataView
    #position: int = 0

    private constructor(view: DataView) {this.#view = view}

    get remaining(): int {return this.#view.byteLength - this.#position}

    get position(): int {return this.#position}
    set position(value: int) {
        if (value < 0) {
            panic(`position(${value}) cannot be negative.`)
        } else if (value > this.#view.byteLength) {
            panic(`position(${value}) is outside range (${this.#view.byteLength}).`)
        } else {
            this.#position = value
        }
    }

    writeBoolean(value: boolean): void {this.writeByte(value ? 1 : 0)}

    writeByte(value: byte): void {
        this.#ensureSpace(1)
        this.#view.setInt8(this.#position++, value)
    }

    writeShort(value: short): void {
        this.#ensureSpace(Int16Array.BYTES_PER_ELEMENT)
        this.#view.setInt16(this.#position, value, this.littleEndian)
        this.#position += Int16Array.BYTES_PER_ELEMENT
    }

    writeInt(value: int): void {
        this.#ensureSpace(Int32Array.BYTES_PER_ELEMENT)
        this.#view.setInt32(this.#position, value, this.littleEndian)
        this.#position += Int32Array.BYTES_PER_ELEMENT
    }

    writeLong(value: bigint): void {
        this.#ensureSpace(BigInt64Array.BYTES_PER_ELEMENT)
        this.#view.setBigInt64(this.#position, value, this.littleEndian)
        this.#position += BigInt64Array.BYTES_PER_ELEMENT
    }

    writeFloat(value: float): void {
        this.#ensureSpace(Float32Array.BYTES_PER_ELEMENT)
        this.#view.setFloat32(this.#position, value, this.littleEndian)
        this.#position += Float32Array.BYTES_PER_ELEMENT
    }

    writeDouble(value: double): void {
        this.#ensureSpace(Float64Array.BYTES_PER_ELEMENT)
        this.#view.setFloat64(this.#position, value, this.littleEndian)
        this.#position += Float64Array.BYTES_PER_ELEMENT
    }

    writeBytes(bytes: Int8Array): void {
        this.#ensureSpace(bytes.length)
        for (let i: int = 0; i < bytes.length; ++i) {
            this.#view.setInt8(this.#position++, bytes[i])
        }
    }

    writeString(value: string): void {
        const length = value.length
        this.#ensureSpace(Int32Array.BYTES_PER_ELEMENT + length * Int16Array.BYTES_PER_ELEMENT)
        this.writeInt(length)
        for (let i = 0; i < length; i++) {
            this.writeShort(value.charCodeAt(i))
        }
    }

    toArrayBuffer(): ArrayBufferLike {return this.#view.buffer.slice(0, this.#position)}

    #ensureSpace(count: int): void {
        const capacity = this.#view.byteLength
        if (this.#position + count > capacity) {
            const o = this.#view
            this.#view = new DataView(new ArrayBuffer(nextPowOf2(capacity + count)))
            for (let i = 0; i < this.#position; i++) {
                this.#view.setInt8(i, o.getInt8(i))
            }
        }
    }
}

export class ByteCounter implements DataOutput {
    #count: int = 0 | 0
    writeByte(_: byte): void {this.#count++}
    writeShort(_: short): void {this.#count += 2}
    writeInt(_: int): void {this.#count += 4}
    writeLong(_: bigint): void {this.#count += 8}
    writeFloat(_: float): void {this.#count += 4}
    writeDouble(_: double): void {this.#count += 8}
    writeBoolean(_: boolean): void {this.#count++}
    writeBytes(bytes: Int8Array): void {this.#count += bytes.length}
    writeString(value: string): void {this.#count += value.length + 4}
    get count(): int {return this.#count}
}

// WASM CONTRACT: this rolling 32-byte XOR checksum (multi-byte values folded little-endian) is
// reimplemented in Rust (crates/boxgraph checksum.rs) and compared after every transaction. Do not
// change the algorithm or width.
export class Checksum implements DataOutput, Equality<Checksum> {
    readonly #result: Int8Array

    #cursor: int = 0

    constructor(length: int = 32) {
        this.#result = new Int8Array(length)
    }

    result(): Int8Array {return this.#result}

    equals(other: Checksum): boolean {
        if (other === this) {return true}
        return this.#result.every((value: byte, index: int) => other.#result[index] === value)
    }

    writeBoolean(value: boolean): void {
        this.writeByte(value ? 31 : 11)
    }

    writeShort(value: short): void {
        this.writeByte(value & 0xff)
        this.writeByte((value >>> 8) & 0xff)
    }

    writeByte(value: byte): void {
        if (this.#cursor >= this.#result.length) {this.#cursor = 0}
        this.#result[this.#cursor++] ^= value
    }

    writeInt(value: int): void {
        this.writeByte(value & 0xff)
        this.writeByte((value >>> 8) & 0xff)
        this.writeByte((value >>> 16) & 0xff)
        this.writeByte((value >>> 24) & 0xff)
    }

    writeBytes(bytes: Int8Array): void {
        bytes.forEach(value => this.writeByte(value))
    }

    writeFloat(value: float): void {
        this.writeInt(Float.floatToIntBits(value))
    }

    writeDouble(value: double): void {
        this.writeLong(Float64.float64ToLongBits(value))
    }

    writeLong(value: bigint): void {
        this.writeByte(Number(value) & 0xff)
        this.writeByte(Number(value >> 8n) & 0xff)
        this.writeByte(Number(value >> 16n) & 0xff)
        this.writeByte(Number(value >> 24n) & 0xff)
        this.writeByte(Number(value >> 32n) & 0xff)
        this.writeByte(Number(value >> 40n) & 0xff)
        this.writeByte(Number(value >> 48n) & 0xff)
        this.writeByte(Number(value >> 56n) & 0xff)
    }

    writeString(value: string): void {
        for (let i = 0; i < value.length; i++) {
            this.writeShort(value.charCodeAt(i))
        }
    }

    toHexString(): string {
        return Array.from(Iterables.map(this.#result.values(), value =>
            (value & 0xff).toString(16).padStart(2, "0"))).join("")
    }
}

export class ByteArrayInput implements DataInput {
    littleEndian: boolean = false

    readonly #view: DataView

    #position: int = 0

    constructor(buffer: ArrayBufferLike, byteOffset: int = 0) {this.#view = new DataView(buffer, byteOffset)}

    get position(): int {return this.#position}

    set position(value: int) {
        if (value < 0) {
            panic(`position(${value}) cannot be negative.`)
        } else if (value > this.#view.byteLength) {
            panic(`position(${value}) is outside range (${this.#view.byteLength}).`)
        } else {
            this.#position = value
        }
    }

    readByte(): byte {return this.#view.getInt8(this.#position++)}

    readShort(): short {
        const read = this.#view.getInt16(this.#position, this.littleEndian)
        this.#position += Int16Array.BYTES_PER_ELEMENT
        return read
    }

    readInt(): int {
        const read = this.#view.getInt32(this.#position, this.littleEndian)
        this.#position += Int32Array.BYTES_PER_ELEMENT
        return read
    }

    readLong(): bigint {
        const read = this.#view.getBigInt64(this.#position, this.littleEndian)
        this.#position += BigInt64Array.BYTES_PER_ELEMENT
        return read
    }

    readFloat(): float {
        const read = this.#view.getFloat32(this.#position, this.littleEndian)
        this.#position += Float32Array.BYTES_PER_ELEMENT
        return read
    }

    readDouble(): double {
        const read = this.#view.getFloat64(this.#position, this.littleEndian)
        this.#position += Float64Array.BYTES_PER_ELEMENT
        return read
    }

    readBoolean(): boolean {return this.readByte() === 1}

    readBytes(array: Int8Array): void {
        for (let i = 0; i < array.length; i++) {array[i] = this.readByte()}
    }

    readString(): string {
        const length = this.readInt()
        let result = ""
        for (let i = 0; i < length; i++) {result += String.fromCharCode(this.readShort())}
        return result
    }

    available(count: int): boolean {return this.#position + count <= this.#view.byteLength}

    remaining(): int {return this.#view.byteLength - this.#position}

    skip(count: int): void {this.position += count}
}