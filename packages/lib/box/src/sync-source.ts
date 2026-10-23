import {Arrays, EmptyExec, panic, Terminable, Terminator} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {BoxGraph} from "./graph"
import {Update} from "./updates"
import {BytesSplice} from "./bytes-splice"
import {PrimitiveType} from "./primitive"
import {Synchronization, UpdateTask} from "./sync"

export class SyncSource<M> implements Terminable {
    static readonly DEBUG_CHECKSUM = false

    readonly #terminator: Terminator
    readonly #caller: Synchronization<M>

    constructor(graph: BoxGraph<M>, messenger: Messenger, initialize?: boolean) {
        this.#terminator = new Terminator()
        this.#caller = Communicator.sender(messenger, ({dispatchAndForget, dispatchAndReturn}) =>
            new class implements Synchronization<M> {
                sendUpdates(updates: ReadonlyArray<UpdateTask<M>>): void {
                    dispatchAndForget(this.sendUpdates, updates)
                }
                checksum(value: Int8Array): Promise<void> {
                    return dispatchAndReturn(this.checksum, value)
                }
            })

        if (initialize === true) {
            const boxes = graph.boxes()
            if (boxes.length > 0) {
                this.#caller.sendUpdates(boxes.map<UpdateTask<M>>(box =>
                    ({type: "new", name: box.name as keyof M, uuid: box.address.uuid, buffer: box.toArrayBuffer()})))
            }
        }

        const updates: Array<UpdateTask<M>> = []

        this.#terminator.own(graph.subscribeTransaction({
            onBeginTransaction: EmptyExec,
            onEndTransaction: (rolledBack) => {
                if (rolledBack) {
                    Arrays.clear(updates)
                    return
                }
                this.#caller.sendUpdates(updates)
                if (SyncSource.DEBUG_CHECKSUM) {
                    this.#caller.checksum(graph.checksum()).then(EmptyExec, (reason) => panic(reason))
                }
                Arrays.clear(updates)
            }
        }))

        this.#terminator.own(graph.subscribeToAllUpdatesImmediate({
            onUpdate: (update: Update): unknown => updates.push(UpdateTasks.of<M>(update))
        }))
    }

    checksum(value: Int8Array): Promise<void> {return this.#caller.checksum(value)}
    terminate() {this.#terminator.terminate()}
}

export namespace UpdateTasks {
    /** The forward-only task of an update. A bytes field changed in one range sends only that range when it is smaller. */
    export const of = <M>(update: Update): UpdateTask<M> => {
        if (update.type === "new") {
            return {type: "new", name: update.name as keyof M, uuid: update.uuid, buffer: update.settings}
        } else if (update.type === "primitive") {
            const {oldValue, newValue} = update
            if (update.serialization.type === PrimitiveType.Bytes
                && oldValue instanceof Int8Array && newValue instanceof Int8Array) {
                const splice = BytesSplice.of(oldValue, newValue)
                if (splice.nonEmpty() && BytesSplice.cost(splice.unwrap()) < newValue.length) {
                    const {offset, deleteCount, insert} = splice.unwrap()
                    return {type: "update-bytes", address: update.address.decompose(), offset, deleteCount, bytes: insert}
                }
            }
            return {
                type: "update-primitive", address: update.address.decompose(),
                primitiveType: update.serialization.type, value: newValue
            }
        } else if (update.type === "pointer") {
            return {type: "update-pointer", address: update.address.decompose(), target: update.newAddress.unwrapOrNull()?.decompose()}
        } else if (update.type === "delete") {
            return {type: "delete", uuid: update.uuid}
        }
        return panic(`Unknown ${update}`)
    }
}
