import {Arrays, ByteArrayInput, isDefined, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {Communicator, Messenger} from "@moises-ai/lib-runtime"
import {BoxGraph} from "./graph"
import {Address} from "./address"
import {Synchronization, UpdateTask} from "./sync"
import {PointerField} from "./pointer"
import {PrimitiveField, PrimitiveValues} from "./primitive"

export const createSyncTarget = <M>(graph: BoxGraph<M>, messenger: Messenger): Terminable => {
    return Communicator.executor<Synchronization<M>>(messenger, new class implements Synchronization<M> {
        sendUpdates(updates: ReadonlyArray<UpdateTask<M>>): void {
            graph.beginTransaction()
            updates.forEach(update => {
                const type = update.type
                if (type === "new") {
                    graph.createBox(update.name, update.uuid, box => box.read(new ByteArrayInput(update.buffer)))
                } else if (type === "update-primitive") {
                    (graph.findVertex(Address.reconstruct(update.address))
                        .unwrap(() => `Could not find primitive field ${update.address}`) as PrimitiveField)
                        .setValue(update.value as PrimitiveValues)
                } else if (type === "update-pointer") {
                    (graph.findVertex(Address.reconstruct(update.address))
                        .unwrap(() => `Could not find pointer field ${update.address}`) as PointerField)
                        .targetAddress = isDefined(update.target)
                        ? Option.wrap(Address.reconstruct(update.target))
                        : Option.None
                } else if (update.type === "delete") {
                    graph.unstageBox(graph.findBox(update.uuid).unwrap(() => `Could not find box ${UUID.toString(update.uuid)}`))
                }
            })
            graph.endTransaction()
        }

        checksum(value: Int8Array): Promise<void> {
            if (Arrays.equals(graph.checksum(), value)) {
                return Promise.resolve()
            } else {
                return Promise.reject("Checksum mismatch")
            }
        }
    })
}