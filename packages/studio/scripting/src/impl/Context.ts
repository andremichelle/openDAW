import {Box, BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Func, isDefined, Optional, Provider, tryCatch} from "@opendaw/lib-std"
import {Sample} from "../Api"

export class Context {
    readonly #skeleton: ProjectSkeleton
    readonly #facades: WeakMap<Box, object>
    readonly #samples: Map<string, Sample>

    constructor(skeleton: ProjectSkeleton) {
        this.#skeleton = skeleton
        this.#facades = new WeakMap<Box, object>()
        this.#samples = new Map<string, Sample>()
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
