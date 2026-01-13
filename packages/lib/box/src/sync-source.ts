import {Arrays, EmptyExec, panic, Terminable, Terminator} from "@moises-ai/lib-std"
import {Communicator, Messenger} from "@moises-ai/lib-runtime"
import {BoxGraph} from "./graph"
import {Update} from "./updates"
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
            onEndTransaction: () => {
                this.#caller.sendUpdates(updates)
                if (SyncSource.DEBUG_CHECKSUM) {
                    this.#caller.checksum(graph.checksum()).then(EmptyExec, (reason) => panic(reason))
                }
                Arrays.clear(updates)
            }
        }))

        this.#terminator.own(graph.subscribeToAllUpdatesImmediate({
            onUpdate: (update: Update): void => {
                if (update.type === "new") {
                    updates.push({
                        type: "new",
                        name: update.name as keyof M,
                        uuid: update.uuid,
                        buffer: update.settings
                    })
                } else if (update.type === "primitive") {
                    updates.push({
                        type: "update-primitive",
                        address: update.address.decompose(),
                        value: update.newValue
                    })
                } else if (update.type === "pointer") {
                    updates.push({
                        type: "update-pointer",
                        address: update.address.decompose(),
                        target: update.newAddress.unwrapOrNull()?.decompose()
                    })
                } else if (update.type === "delete") {
                    updates.push({
                        type: "delete",
                        uuid: update.uuid
                    })
                } else {
                    return panic(`Unknown ${update}`)
                }
            }
        }))
    }

    checksum(value: Int8Array): Promise<void> {return this.#caller.checksum(value)}
    terminate() {this.#terminator.terminate()}
}