import * as Y from "yjs"
import {int, isInstanceOf} from "@opendaw/lib-std"

// A bytes field in a room. Up to CHUNK bytes it is one plain Uint8Array, written whole. Larger, it is a map of CHUNK
// sized chunks and a meta entry, and a write sends only the chunks that differ.
//
// Every write carries a generation (the writer's client id and a counter). Each chunk stores the generation that
// wrote it, the meta entry the generation every chunk must have. Yjs resolves each map key on its own, so two writes
// at once can leave chunks of both: the field is torn, nobody reads it, and the client whose generation won the meta
// entry writes the chunks that differ again from its own value.
export namespace YBytes {
    export const CHUNK = 16 * 1024
    const META = "meta"
    const GENERATION_BYTES = 8
    const META_HEAD = 4 + 4 + GENERATION_BYTES

    export type Generation = { readonly client: int, readonly counter: int }

    /** Hands out the generations of one client. */
    export class Generator {
        #counter: int = 0
        constructor(readonly client: int) {}
        next(): Generation {return {client: this.client, counter: ++this.#counter}}
    }

    export type Read =
        | { readonly type: "whole", readonly value: Int8Array }
        | { readonly type: "torn", readonly owner: int }

    type Meta = { size: int, count: int, writer: Generation, expected: Array<Generation> }

    const sameGeneration = (a: Generation, b: Generation): boolean => a.client === b.client && a.counter === b.counter

    const chunkCount = (size: int): int => Math.ceil(size / CHUNK)

    const writeGeneration = (view: DataView, at: int, {client, counter}: Generation): void => {
        view.setUint32(at, client >>> 0, true)
        view.setUint32(at + 4, counter >>> 0, true)
    }

    const readGeneration = (view: DataView, at: int): Generation =>
        ({client: view.getUint32(at, true), counter: view.getUint32(at + 4, true)})

    const encodeMeta = ({size, count, writer, expected}: Meta): Uint8Array => {
        const bytes = new Uint8Array(META_HEAD + count * GENERATION_BYTES)
        const view = new DataView(bytes.buffer)
        view.setUint32(0, size, true)
        view.setUint32(4, count, true)
        writeGeneration(view, 8, writer)
        expected.forEach((generation, index) => writeGeneration(view, META_HEAD + index * GENERATION_BYTES, generation))
        return bytes
    }

    const decodeMeta = (value: unknown): Meta | null => {
        if (!isInstanceOf(value, Uint8Array) || value.length < META_HEAD) {return null}
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
        const size = view.getUint32(0, true)
        const count = view.getUint32(4, true)
        if (count !== chunkCount(size) || value.length !== META_HEAD + count * GENERATION_BYTES) {return null}
        const expected = Array.from({length: count}, (_, index) => readGeneration(view, META_HEAD + index * GENERATION_BYTES))
        return {size, count, writer: readGeneration(view, 8), expected}
    }

    const encodeChunk = (generation: Generation, data: Uint8Array): Uint8Array => {
        const bytes = new Uint8Array(GENERATION_BYTES + data.length)
        writeGeneration(new DataView(bytes.buffer), 0, generation)
        bytes.set(data, GENERATION_BYTES)
        return bytes
    }

    const chunkOf = (value: Uint8Array, index: int): Uint8Array => value.subarray(index * CHUNK, Math.min(value.length, (index + 1) * CHUNK))

    const asUnsigned = (value: Readonly<Int8Array>): Uint8Array => new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

    const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])

    const storedChunk = (map: Y.Map<unknown>, index: int): { generation: Generation, data: Uint8Array } | null => {
        const value = map.get(String(index))
        if (!isInstanceOf(value, Uint8Array) || value.length < GENERATION_BYTES) {return null}
        return {
            generation: readGeneration(new DataView(value.buffer, value.byteOffset, value.byteLength), 0),
            data: value.subarray(GENERATION_BYTES)
        }
    }

    /** Whether `value` is the stored form of a bytes field (plain or chunked). */
    export const isStored = (value: unknown): boolean => isInstanceOf(value, Uint8Array) || isChunked(value)

    export const isChunked = (value: unknown): value is Y.Map<unknown> => isInstanceOf(value, Y.Map) && value.has(META)

    /** The stored form of `value`, for a field the room does not hold yet. */
    export const create = (value: Readonly<Int8Array>, generation: Generation): Uint8Array | Y.Map<unknown> => {
        const bytes = asUnsigned(value)
        if (bytes.length <= CHUNK) {return bytes.slice()}
        const map = new Y.Map<unknown>()
        const count = chunkCount(bytes.length)
        for (let index = 0; index < count; index++) {map.set(String(index), encodeChunk(generation, chunkOf(bytes, index)))}
        map.set(META, encodeMeta({size: bytes.length, count, writer: generation, expected: Array.from({length: count}, () => generation)}))
        return map
    }

    /** The field's value, or torn while chunks of different writes are mixed. */
    export const read = (stored: unknown): Read => {
        if (isInstanceOf(stored, Uint8Array)) {return {type: "whole", value: new Int8Array(stored.slice().buffer)}}
        if (!isInstanceOf(stored, Y.Map)) {return {type: "torn", owner: -1}}
        const meta = decodeMeta(stored.get(META))
        if (meta === null) {return {type: "torn", owner: -1}}
        const value = new Int8Array(meta.size)
        const target = asUnsigned(value)
        for (let index = 0; index < meta.count; index++) {
            const chunk = storedChunk(stored, index)
            const length = Math.min(CHUNK, meta.size - index * CHUNK)
            if (chunk === null || !sameGeneration(chunk.generation, meta.expected[index]) || chunk.data.length !== length) {
                return {type: "torn", owner: meta.writer.client}
            }
            target.set(chunk.data, index * CHUNK)
        }
        return {type: "whole", value}
    }

    /** Writes `value` over the stored field under `key` of `parent`, only what differs. Returns the chunks written. */
    export const write = (parent: Y.Map<unknown>, key: string, value: Readonly<Int8Array>, generation: Generation): int => {
        const bytes = asUnsigned(value)
        const stored = parent.get(key)
        if (bytes.length <= CHUNK || !isChunked(stored)) {
            const created = create(value, generation)
            parent.set(key, created)
            return isInstanceOf(created, Y.Map) ? chunkCount(bytes.length) : 1
        }
        const meta = decodeMeta(stored.get(META))
        const count = chunkCount(bytes.length)
        const expected: Array<Generation> = []
        let written = 0
        for (let index = 0; index < count; index++) {
            const data = chunkOf(bytes, index)
            const chunk = storedChunk(stored, index)
            const wanted = meta !== null && index < meta.count ? meta.expected[index] : null
            if (chunk !== null && wanted !== null && sameGeneration(chunk.generation, wanted) && sameBytes(chunk.data, data)) {
                expected.push(chunk.generation)
            } else {
                stored.set(String(index), encodeChunk(generation, data))
                expected.push(generation)
                written++
            }
        }
        Array.from(stored.keys())
            .filter(entry => entry !== META && Number(entry) >= count)
            .forEach(entry => stored.delete(entry))
        stored.set(META, encodeMeta({size: bytes.length, count, writer: generation, expected}))
        return written
    }

    /** The owner of the winning write puts back the chunks another write mixed in. Returns the chunks written. */
    export const repair = (stored: Y.Map<unknown>, value: Readonly<Int8Array>): int => {
        const meta = decodeMeta(stored.get(META))
        const bytes = asUnsigned(value)
        if (meta === null || meta.size !== bytes.length) {return 0}
        let written = 0
        for (let index = 0; index < meta.count; index++) {
            const data = chunkOf(bytes, index)
            const chunk = storedChunk(stored, index)
            if (chunk === null || !sameGeneration(chunk.generation, meta.expected[index]) || !sameBytes(chunk.data, data)) {
                stored.set(String(index), encodeChunk(meta.expected[index], data))
                written++
            }
        }
        return written
    }

    /** The value a client with this read would deliver, none while torn. */
    export const valueOf = (read: Read): Int8Array | null => read.type === "whole" ? read.value : null

    export const ownsRepair = (read: Read, client: int): boolean => read.type === "torn" && read.owner === client
}
