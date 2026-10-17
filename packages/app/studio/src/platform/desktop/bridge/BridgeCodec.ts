import {ByteArrayInput, ByteArrayOutput, int, isDefined, Optional, panic} from "@opendaw/lib-std"

// Structured-clone-like binary codec for messages between the studio and the native engine process.
// SharedArrayBuffers travel as ids. Each side keeps its own copy, the relays keep them in step.
export namespace BridgeCodec {
    export interface SharedBuffers {
        idOf(buffer: SharedArrayBuffer): int
        bufferOf(id: int, byteLength: int): SharedArrayBuffer
        // ports relayed as messages (the offline render), without them a port arrives inert
        idOfPort?(port: MessagePort): Optional<int>
        portOf?(id: int): unknown
    }

    const enum Tag {Undefined, Null, False, True, Number, String, Array, Object, ArrayBuffer, Typed, Shared, Error, Map, Set, BigInt, Port, LinkedPort}

    const TypedKinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
        Float32Array, Float64Array, BigInt64Array, BigUint64Array] as const

    // MIDI ports do not cross the process boundary yet, a port arrives as one that drops everything
    const InertPort = {postMessage: () => {}, start: () => {}, close: () => {}, onmessage: null}

    const isShared = (value: unknown): value is SharedArrayBuffer =>
        typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer

    const writeBytes = (output: ByteArrayOutput, bytes: Uint8Array): void => {
        output.writeInt(bytes.length)
        output.writeBytes(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length))
    }

    const readBytes = (input: ByteArrayInput): Uint8Array<ArrayBuffer> => {
        const bytes = new Int8Array(input.readInt())
        input.readBytes(bytes)
        return new Uint8Array(bytes.buffer)
    }

    const write = (output: ByteArrayOutput, value: unknown, shared: SharedBuffers): void => {
        if (value === undefined || typeof value === "function" || typeof value === "symbol") {
            output.writeByte(Tag.Undefined)
        } else if (value === null) {
            output.writeByte(Tag.Null)
        } else if (typeof value === "boolean") {
            output.writeByte(value ? Tag.True : Tag.False)
        } else if (typeof value === "number") {
            output.writeByte(Tag.Number)
            output.writeDouble(value)
        } else if (typeof value === "bigint") {
            output.writeByte(Tag.BigInt)
            output.writeString(value.toString())
        } else if (typeof value === "string") {
            output.writeByte(Tag.String)
            output.writeString(value)
        } else if (Array.isArray(value)) {
            output.writeByte(Tag.Array)
            output.writeInt(value.length)
            value.forEach(item => write(output, item, shared))
        } else if (value instanceof ArrayBuffer) {
            output.writeByte(Tag.ArrayBuffer)
            writeBytes(output, new Uint8Array(value))
        } else if (isShared(value)) {
            output.writeByte(Tag.Shared)
            output.writeInt(shared.idOf(value))
            output.writeInt(value.byteLength)
        } else if (ArrayBuffer.isView(value)) {
            const kind = TypedKinds.findIndex(type => value instanceof type)
            if (kind < 0) {return panic(`Cannot encode ${value.constructor.name}`)}
            output.writeByte(Tag.Typed)
            output.writeByte(kind)
            writeBytes(output, new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        } else if (typeof MessagePort !== "undefined" && value instanceof MessagePort) {
            const id = shared.idOfPort?.(value)
            if (isDefined(id)) {
                output.writeByte(Tag.LinkedPort)
                output.writeInt(id)
            } else {
                output.writeByte(Tag.Port)
            }
        } else if (value instanceof Error) {
            output.writeByte(Tag.Error)
            output.writeString(value.message)
            output.writeString(value.stack ?? "")
        } else if (value instanceof Map) {
            output.writeByte(Tag.Map)
            output.writeInt(value.size)
            value.forEach((entry, key) => {
                write(output, key, shared)
                write(output, entry, shared)
            })
        } else if (value instanceof Set) {
            output.writeByte(Tag.Set)
            output.writeInt(value.size)
            value.forEach(entry => write(output, entry, shared))
        } else {
            const entries = Object.entries(value as object)
            output.writeByte(Tag.Object)
            output.writeInt(entries.length)
            entries.forEach(([key, entry]) => {
                output.writeString(key)
                write(output, entry, shared)
            })
        }
    }

    const read = (input: ByteArrayInput, shared: SharedBuffers): unknown => {
        const tag = input.readByte()
        switch (tag) {
            case Tag.Undefined:
                return undefined
            case Tag.Null:
                return null
            case Tag.False:
                return false
            case Tag.True:
                return true
            case Tag.Number:
                return input.readDouble()
            case Tag.BigInt:
                return BigInt(input.readString())
            case Tag.String:
                return input.readString()
            case Tag.Array:
                return Array.from({length: input.readInt()}, () => read(input, shared))
            case Tag.ArrayBuffer:
                return readBytes(input).buffer
            case Tag.Shared: {
                const id = input.readInt()
                return shared.bufferOf(id, input.readInt())
            }
            case Tag.Typed: {
                const type = TypedKinds[input.readByte()]
                const bytes = readBytes(input)
                return new type(bytes.buffer, 0, bytes.byteLength / type.BYTES_PER_ELEMENT)
            }
            case Tag.Error: {
                const error = new Error(input.readString())
                error.stack = input.readString()
                return error
            }
            case Tag.Map: {
                const map = new Map<unknown, unknown>()
                const size = input.readInt()
                for (let index = 0; index < size; index++) {map.set(read(input, shared), read(input, shared))}
                return map
            }
            case Tag.Set: {
                const set = new Set<unknown>()
                const size = input.readInt()
                for (let index = 0; index < size; index++) {set.add(read(input, shared))}
                return set
            }
            case Tag.Port:
                return InertPort
            case Tag.LinkedPort: {
                const id = input.readInt()
                return shared.portOf?.(id) ?? InertPort
            }
            case Tag.Object: {
                const object: Record<string, unknown> = {}
                const size = input.readInt()
                for (let index = 0; index < size; index++) {object[input.readString()] = read(input, shared)}
                return object
            }
            default:
                return panic(`Unknown tag ${tag}`)
        }
    }

    export const encode = (value: unknown, shared: SharedBuffers): ArrayBuffer => {
        const output = ByteArrayOutput.create()
        write(output, value, shared)
        return output.toArrayBuffer() as ArrayBuffer
    }

    export const decode = (bytes: ArrayBuffer, shared: SharedBuffers): unknown => {
        const value = read(new ByteArrayInput(bytes), shared)
        return isDefined(value) ? value : undefined
    }
}
