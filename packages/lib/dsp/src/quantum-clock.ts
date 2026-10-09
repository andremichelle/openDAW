import {int} from "@opendaw/lib-std"
import {RenderQuantum} from "./constants"

// Chrome's worklet clock can lag a quantum or more while the main thread holds the graph lock (crbug 442866743)
export class QuantumClock {
    #calls: int = 0
    #origin: number = Number.NEGATIVE_INFINITY

    advance(currentFrame: number): number {
        this.#origin = Math.max(this.#origin, currentFrame - this.#calls * RenderQuantum)
        return this.frameOf(this.#calls++)
    }

    frameOf(call: int): number {return this.#origin + call * RenderQuantum}

    get calls(): int {return this.#calls}
}
