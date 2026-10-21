import {asInstanceOf, EmptyExec, Exec, isDefined, Optional, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {Field, Propagation} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ScriptBufferBox, ScriptBufferChunkBox} from "@opendaw/studio-boxes"
import {BufferDeclaration} from "./ScriptDeclaration"

type Hub = Field<Pointers.ScriptBuffer>

// floats per ScriptBufferChunkBox: an edit stores (and undoes, and syncs) only the chunks it touches
const CHUNK = 256

const boxes = (hub: Hub): Array<ScriptBufferBox> => hub.pointerHub.filter().map(({box}) => asInstanceOf(box, ScriptBufferBox))

const find = (hub: Hub, name: string): Optional<ScriptBufferBox> => boxes(hub).find(box => box.label.getValue() === name)

const chunksOf = (buffer: ScriptBufferBox): Array<ScriptBufferChunkBox> => buffer.chunks.pointerHub.filter()
    .map(({box}) => asInstanceOf(box, ScriptBufferChunkBox))

// little-endian float32 (every platform the studio runs on), WASM CONTRACT: the engine decodes it with from_le_bytes
const encode = (values: Float32Array): Int8Array => new Int8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength))

const decode = (bytes: Readonly<Int8Array>, length: number): Float32Array => {
    const values = new Float32Array(length)
    values.set(new Float32Array(bytes.buffer, bytes.byteOffset, Math.min(length, bytes.byteLength >> 2)))
    return values
}

const chunkLength = (length: number, index: number): number => Math.min(CHUNK, length - index * CHUNK)

// a buffer saved as one blob (before chunks): split it into chunks and clear the blob, inside the caller's transaction
const migrateLegacy = (buffer: ScriptBufferBox): void => {
    const legacy = buffer.data.getValue()
    if (legacy.byteLength === 0 || buffer.chunks.pointerHub.size() > 0) {return}
    const values = decode(legacy, legacy.byteLength >> 2)
    for (let index = 0; index * CHUNK < values.length; index++) {
        createChunk(buffer, index, values.slice(index * CHUNK, (index + 1) * CHUNK))
    }
    buffer.data.setValue(new Int8Array(0))
}

const createChunk = (buffer: ScriptBufferBox, index: number, values: Float32Array): void => {
    ScriptBufferChunkBox.create(buffer.graph, UUID.generate(), chunk => {
        chunk.owner.refer(buffer.chunks)
        chunk.index.setValue(index)
        chunk.data.setValue(encode(values))
    })
}

// Every edit runs inside the caller's transaction (`editing.modify`).
export namespace ScriptBuffers {
    export const CHUNK_SIZE = CHUNK

    // a new buffer starts at zero, a changed length keeps the values it still covers
    export const reconcile = (hub: Hub, declared: ReadonlyArray<BufferDeclaration>): void => {
        for (const box of boxes(hub)) {
            if (!declared.some(({name}) => name === box.label.getValue())) {box.delete()}
        }
        for (const {name, index, length} of declared) {
            const buffer = find(hub, name) ?? ScriptBufferBox.create(hub.box.graph, UUID.generate(), created => {
                created.owner.refer(hub)
                created.label.setValue(name)
                created.index.setValue(index)
            })
            if (buffer.index.getValue() !== index) {buffer.index.setValue(index)}
            migrateLegacy(buffer)
            const count = Math.ceil(length / CHUNK)
            const chunks = chunksOf(buffer)
            for (const chunk of chunks) {
                if (chunk.index.getValue() >= count) {chunk.delete()}
            }
            for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
                const size = chunkLength(length, chunkIndex)
                const chunk = chunks.find(candidate => candidate.index.getValue() === chunkIndex)
                if (!isDefined(chunk)) {
                    createChunk(buffer, chunkIndex, new Float32Array(size))
                } else if (chunk.data.getValue().byteLength !== size * 4) {
                    chunk.data.setValue(encode(decode(chunk.data.getValue(), size)))
                }
            }
        }
    }

    export const read = (hub: Hub, buffer: BufferDeclaration): Float32Array => {
        const values = new Float32Array(buffer.length)
        const box = find(hub, buffer.name)
        if (!isDefined(box)) {return values}
        if (box.chunks.pointerHub.size() === 0) {
            values.set(decode(box.data.getValue(), buffer.length))
            return values
        }
        for (const chunk of chunksOf(box)) {
            const offset = chunk.index.getValue() * CHUNK
            if (offset >= buffer.length) {continue}
            values.set(decode(chunk.data.getValue(), chunkLength(buffer.length, chunk.index.getValue())), offset)
        }
        return values
    }

    // overwrites `values` from `offset` on, touching only the chunks they cover; values outside the buffer are
    // dropped, non-finite values become 0
    export const write = (hub: Hub, buffer: BufferDeclaration, offset: number, values: ArrayLike<number>): void => {
        const box = find(hub, buffer.name)
        if (!isDefined(box) || !Number.isInteger(offset)) {return}
        const from = Math.max(0, offset), to = Math.min(buffer.length, offset + values.length)
        if (to <= from) {return}
        migrateLegacy(box)
        const chunks = chunksOf(box)
        for (let chunkIndex = Math.floor(from / CHUNK); chunkIndex <= Math.floor((to - 1) / CHUNK); chunkIndex++) {
            const size = chunkLength(buffer.length, chunkIndex)
            const chunk = chunks.find(candidate => candidate.index.getValue() === chunkIndex)
            const current = isDefined(chunk) ? decode(chunk.data.getValue(), size) : new Float32Array(size)
            const start = chunkIndex * CHUNK
            for (let position = Math.max(from, start); position < Math.min(to, start + size); position++) {
                const value = values[position - offset]
                current[position - start] = Number.isFinite(value) ? value : 0
            }
            if (isDefined(chunk)) {
                chunk.data.setValue(encode(current))
            } else {
                createChunk(box, chunkIndex, current)
            }
        }
    }

    // Calls `observer` once at the end of every transaction that touched a buffer of the hub.
    export const observe = (hub: Hub, observer: Exec): Terminable => {
        const graph = hub.box.graph
        const state: { dirty: boolean, structural: boolean } = {dirty: false, structural: false}
        const children = new Terminator()
        const markDirty = (): void => {state.dirty = true}
        const markStructural = (): void => {
            state.dirty = true
            state.structural = true
        }
        const subscribeChildren = (): void => {
            children.terminate()
            for (const buffer of boxes(hub)) {
                children.ownAll(
                    graph.subscribeVertexUpdates(Propagation.Children, buffer.address, markDirty),
                    buffer.chunks.pointerHub.subscribe({onAdded: markStructural, onRemoved: markStructural}),
                    ...chunksOf(buffer).map(chunk => graph.subscribeVertexUpdates(Propagation.Children, chunk.address, markDirty))
                )
            }
        }
        subscribeChildren()
        return Terminable.many(
            hub.pointerHub.subscribe({onAdded: markStructural, onRemoved: markStructural}),
            graph.subscribeTransaction({
                onBeginTransaction: EmptyExec,
                onEndTransaction: () => {
                    if (!state.dirty) {return}
                    state.dirty = false
                    if (state.structural) {
                        state.structural = false
                        subscribeChildren()
                    }
                    observer()
                }
            }),
            children
        )
    }
}
