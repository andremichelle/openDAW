// Serialize SyncSource's forward-only UpdateTask[] into the byte stream the Rust engine's
// decode_forward consumes. Each update-primitive task carries the field's codec (primitiveType) captured
// at emission time, so the stream is self-contained: a later task in the same batch may have deleted the
// box (e.g. undo trims a region, then unstages it — #287), and re-resolving the field against the live
// graph here would throw "no field at". Everything is written on the main thread's ordered channel.

import {ByteArrayOutput, isDefined, UUID} from "@opendaw/lib-std"
import {Address, PrimitiveValues, UpdateTask, ValueSerialization} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"

export const serializeUpdateTasks = (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): ArrayBuffer => {
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
            Address.reconstruct(task.address).write(output)
            const serialization: ValueSerialization = ValueSerialization[task.primitiveType]
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
