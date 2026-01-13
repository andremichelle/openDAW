import {Id, int} from "@moises-ai/lib-std"
import {AudioBuffer, NoteEvent} from "@moises-ai/lib-dsp"
import {Block} from "../processing"
import {VoicingStrategy} from "./VoicingStrategy"

export class Voicing {
    #strategy: VoicingStrategy

    readonly #expiring: Array<VoicingStrategy> = []

    constructor(strategy: VoicingStrategy = VoicingStrategy.NotSet) {
        this.#strategy = strategy
    }

    set strategy(strategy: VoicingStrategy) {
        this.#expiring.push(this.#strategy)
        this.#strategy.forceStop()
        this.#strategy = strategy
    }

    get strategy(): VoicingStrategy {return this.#strategy}

    start(event: Id<NoteEvent>): void {
        this.#strategy.start(event)
    }

    stop(id: int): void {
        this.#strategy.stop(id)
    }

    process(output: AudioBuffer, block: Block, fromIndex: int, toIndex: int): void {
        this.#strategy.process(output, block, fromIndex, toIndex)
        for (let i = this.#expiring.length - 1; i >= 0; i--) {
            const strategy = this.#expiring[i]
            if (strategy.process(output, block, fromIndex, toIndex)) {
                this.#expiring.splice(i, 1)
            }
        }
    }

    reset(): void {
        this.#expiring.forEach(strategy => strategy.reset())
        this.#expiring.length = 0
        this.#strategy.reset()
    }
}