import {Arrays} from "./arrays"
import {assert, Comparator, Func, int, panic} from "./lang"
import {SortedSet} from "./sorted-set"
import {DataInput, DataOutput} from "./data"
import {Crypto} from "./crypto"

declare const crypto: Crypto

export namespace UUID {
    export type Bytes = Readonly<Uint8Array>
    export type String = `${string}-${string}-${string}-${string}-${string}`

    export const length = 16 as const

    export const generate = (): Bytes => fromUint8Array(crypto.getRandomValues(new Uint8Array(length)))

    export const sha256 = async (buffer: ArrayBuffer): Promise<Bytes> => {
        const isVitest = typeof process !== "undefined" && process.env?.VITEST === "true"
        return crypto.subtle.digest("SHA-256", isVitest ? new Uint8Array(buffer.slice(0)) : buffer)
            .then(buffer => fromUint8Array(new Uint8Array(buffer.slice(0, length))))
    }

    export const validateBytes = (uuid: UUID.Bytes): UUID.Bytes => UUID.parse(UUID.toString(uuid))
    export const validateString = (uuid: string): uuid is String =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)

    export const asString = (uuid: string): String =>
        validateString(uuid) ? uuid : panic(`Invalid UUID format: ${uuid}`)

    export const fromDataInput = (input: DataInput): Bytes => {
        const array = new Uint8Array(length)
        input.readBytes(new Int8Array(array.buffer))
        return array
    }

    export const toDataOutput = (output: DataOutput, uuid: UUID.Bytes): void =>
        output.writeBytes(new Int8Array(uuid.buffer))

    export const toString = (format: Bytes): UUID.String => {
        const hex: string[] = Arrays.create(index => (index + 0x100).toString(16).substring(1), 256)
        return (hex[format[0]] + hex[format[1]] +
            hex[format[2]] + hex[format[3]] + "-" +
            hex[format[4]] + hex[format[5]] + "-" +
            hex[format[6]] + hex[format[7]] + "-" +
            hex[format[8]] + hex[format[9]] + "-" +
            hex[format[10]] + hex[format[11]] +
            hex[format[12]] + hex[format[13]] +
            hex[format[14]] + hex[format[15]]) as UUID.String
    }

    export const parse = (string: string): Uint8Array => {
        const cleanUuid = string.replace(/-/g, "").toLowerCase()
        if (cleanUuid.length !== 32) {
            return panic(`Invalid UUID format (${string})`)
        }
        const bytes = new Uint8Array(length)
        for (let i = 0, j = 0; i < 32; i += 2, j++) {
            bytes[j] = parseInt(cleanUuid.slice(i, i + 2), 16)
        }
        return bytes
    }

    export const Comparator: Comparator<Bytes> = (a: Bytes, b: Bytes): int => {
        if (a.length !== length || b.length !== length) {
            return panic("Unexpected array length for uuid(v4)")
        }
        for (let i: int = 0; i < length; i++) {
            const delta: int = a[i] - b[i]
            if (delta !== 0) {return delta}
        }
        return 0
    }

    export const equals = (a: UUID.Bytes, b: UUID.Bytes): boolean => Comparator(a, b) === 0

    export const newSet = <T>(key: Func<T, Bytes>) => new SortedSet<Bytes, T>(key, Comparator)

    export const Lowest: Bytes = parse("00000000-0000-4000-8000-000000000000")
    export const Highest: Bytes = parse("FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF")
    export const fromInt = (value: int): Bytes => {
        const result = new Uint8Array(Lowest)
        const array = new Uint8Array(new Uint32Array([value]).buffer)
        for (let i = 0; i < 4; i++) {
            result[i] = array[i]
        }
        return result
    }

    export type ZodLike = { string: typeof import("zod").string }
    export const zType = (z: ZodLike) =>
        z.string()
            .refine((uuid): uuid is UUID.String => UUID.validateString(uuid), {message: "Invalid UUID format (Zod)"})
            .transform(uuid => uuid as UUID.String)

    const fromUint8Array = (arr: Uint8Array): Uint8Array => {
        assert(arr.length === length, "UUID must be 16 bytes long")
        arr[6] = (arr[6] & 0x0f) | 0x40 // Version 4 (random)
        arr[8] = (arr[8] & 0x3f) | 0x80 // Variant 10xx for UUID
        return arr
    }
}