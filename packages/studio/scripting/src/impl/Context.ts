import {Box, BoxGraph, Update, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Arrays, Func, isDefined, Nullable, Optional, panic, Provider, tryCatch} from "@opendaw/lib-std"
import {Sample} from "../Api"

export class Context {
    readonly #skeleton: ProjectSkeleton
    readonly #facades: WeakMap<Box, object>
    readonly #samples: Map<string, Sample>
    readonly #tasks: Array<UpdateTask<BoxIO.TypeMap>>
    readonly #pending: Array<UpdateTask<BoxIO.TypeMap>>
    #origin: Nullable<Int8Array>

    constructor(skeleton: ProjectSkeleton) {
        this.#skeleton = skeleton
        this.#facades = new WeakMap<Box, object>()
        this.#samples = new Map<string, Sample>()
        this.#tasks = []
        this.#pending = []
        this.#origin = null
    }

    // Records every change from now on, so the studio can replay it onto the graph this one was read from.
    startRecording(): void {
        this.#origin = this.boxGraph.checksum()
        this.boxGraph.subscribeToAllUpdatesImmediate({onUpdate: (update: Update) => this.#pending.push(this.#toTask(update))})
        this.boxGraph.subscribeTransaction({
            onBeginTransaction: () => Arrays.clear(this.#pending),
            onEndTransaction: (rolledBack: boolean) => {
                if (!rolledBack) {this.#tasks.push(...this.#pending)}
                Arrays.clear(this.#pending)
            }
        })
    }

    get origin(): Nullable<Int8Array> {return this.#origin}

    takeUpdates(): ReadonlyArray<UpdateTask<BoxIO.TypeMap>> {
        const tasks = this.#tasks.slice()
        Arrays.clear(this.#tasks)
        this.#origin = this.boxGraph.checksum()
        return tasks
    }

    #toTask(update: Update): UpdateTask<BoxIO.TypeMap> {
        switch (update.type) {
            case "new":
                return {type: "new", name: update.name as keyof BoxIO.TypeMap, uuid: update.uuid, buffer: update.settings}
            case "primitive":
                return {
                    type: "update-primitive", address: update.address.decompose(),
                    primitiveType: update.serialization.type, value: update.newValue
                }
            case "pointer":
                return {
                    type: "update-pointer", address: update.address.decompose(),
                    target: update.newAddress.unwrapOrNull()?.decompose()
                }
            case "delete":
                return {type: "delete", uuid: update.uuid}
            default:
                return panic(`Unknown update ${update}`)
        }
    }

    get skeleton(): ProjectSkeleton {return this.#skeleton}
    get samples(): Map<string, Sample> {return this.#samples}
    get boxGraph(): BoxGraph<BoxIO.TypeMap> {return this.#skeleton.boxGraph}

    edit<T>(procedure: Provider<T>): T {
        const boxGraph = this.boxGraph
        if (boxGraph.inTransaction()) {return procedure()}
        boxGraph.beginTransaction()
        const result = tryCatch(procedure)
        if (result.status === "failure") {
            boxGraph.abortTransaction()
            throw result.error
        }
        boxGraph.endTransaction()
        return result.value
    }

    facade<B extends Box, F extends object>(box: B, factory: Func<B, F>): F {
        const existing = this.#facades.get(box)
        if (isDefined(existing)) {return existing as F}
        const created = factory(box)
        this.#facades.set(box, created)
        return created
    }

    optFacade(box: Box): Optional<object> {return this.#facades.get(box)}
}
