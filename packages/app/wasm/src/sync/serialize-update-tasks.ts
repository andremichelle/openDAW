// Serialize SyncSource's forward-only UpdateTask[] into the byte stream the Rust engine's
// decode_forward consumes. Primitive value types are resolved from the source graph's schema, so
// this must run where that graph lives (the main thread), not in the wasm-only worklet.

import {ByteArrayOutput, isDefined, UUID} from "@opendaw/lib-std"
import {Address, BoxGraph, PrimitiveField, PrimitiveValues, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"

export const serializeUpdateTasks = (
    tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>,
    source: BoxGraph<BoxIO.TypeMap>): ArrayBuffer => {
    const output = ByteArrayOutput.create()
    output.writeInt(tasks.length)
    tasks.forEach(task => {
        output.writeString(task.type)
        if (task.type === "new") {
            UUID.toDataOutput(output, task.uuid)
            output.writeString(task.name as string)
            output.writeInt(task.buffer.byteLength)
            output.writeBytes(new Int8Array(task.buffer))
        } else if (task.type === "update-primitive") {
            const address = Address.reconstruct(task.address)
            address.write(output)
            const field = source.findVertex(address).unwrap(() => `no field at ${address}`) as PrimitiveField
            const serialization = field.serialization()
            output.writeString(serialization.type)
            serialization.encode(output, task.value as PrimitiveValues)
        } else if (task.type === "update-pointer") {
            Address.reconstruct(task.address).write(output)
            if (isDefined(task.target)) {
                output.writeBoolean(true)
                Address.reconstruct(task.target).write(output)
            } else {
                output.writeBoolean(false)
            }
        } else if (task.type === "delete") {
            UUID.toDataOutput(output, task.uuid)
        }
    })
    return output.toArrayBuffer() as ArrayBuffer
}
