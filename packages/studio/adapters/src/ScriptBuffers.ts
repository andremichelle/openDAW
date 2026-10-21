import {asInstanceOf, EmptyExec, Exec, isDefined, Optional, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {Field, Propagation} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ScriptBufferBox} from "@opendaw/studio-boxes"
import {BufferDeclaration} from "./ScriptDeclaration"

type Hub = Field<Pointers.ScriptBuffer>

const boxes = (hub: Hub): Array<ScriptBufferBox> => hub.pointerHub.filter().map(({box}) => asInstanceOf(box, ScriptBufferBox))

const find = (hub: Hub, name: string): Optional<ScriptBufferBox> => boxes(hub).find(box => box.label.getValue() === name)

// little-endian float32 (every platform the studio runs on), WASM CONTRACT: the engine decodes it with from_le_bytes
const encode = (values: Float32Array): Int8Array => new Int8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength))

const decode = (bytes: Readonly<Int8Array>, length: number): Float32Array => {
    const values = new Float32Array(length)
    values.set(new Float32Array(bytes.buffer, bytes.byteOffset, Math.min(length, bytes.byteLength >> 2)))
    return values
}

// Every edit runs inside the caller's transaction (`editing.modify`).
export namespace ScriptBuffers {
    // a new buffer starts at zero, a changed length keeps the values it still covers
    export const reconcile = (hub: Hub, declared: ReadonlyArray<BufferDeclaration>): void => {
        for (const box of boxes(hub)) {
            if (!declared.some(({name}) => name === box.label.getValue())) {box.delete()}
        }
        for (const {name, index, length} of declared) {
            const box = find(hub, name)
            if (!isDefined(box)) {
                ScriptBufferBox.create(hub.box.graph, UUID.generate(), created => {
                    created.owner.refer(hub)
                    created.label.setValue(name)
                    created.index.setValue(index)
                    created.data.setValue(encode(new Float32Array(length)))
                })
                continue
            }
            if (box.index.getValue() !== index) {box.index.setValue(index)}
            if (box.data.getValue().byteLength !== length * 4) {box.data.setValue(encode(decode(box.data.getValue(), length)))}
        }
    }

    export const read = (hub: Hub, buffer: BufferDeclaration): Float32Array => {
        const box = find(hub, buffer.name)
        return isDefined(box) ? decode(box.data.getValue(), buffer.length) : new Float32Array(buffer.length)
    }

    // overwrites `values` from `offset` on, values outside the buffer are dropped, non-finite values become 0
    export const write = (hub: Hub, buffer: BufferDeclaration, offset: number, values: ArrayLike<number>): void => {
        const box = find(hub, buffer.name)
        if (!isDefined(box) || !Number.isInteger(offset)) {return}
        const next = decode(box.data.getValue(), buffer.length)
        for (let index = 0; index < values.length; index++) {
            const position = offset + index
            if (position < 0 || position >= buffer.length) {continue}
            const value = values[index]
            next[position] = Number.isFinite(value) ? value : 0
        }
        box.data.setValue(encode(next))
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
            boxes(hub).forEach(box => children.own(graph.subscribeVertexUpdates(Propagation.Children, box.address, markDirty)))
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
