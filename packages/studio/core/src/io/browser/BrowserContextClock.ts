import {isDefined} from "@opendaw/lib-std"
import {ContextClock} from "../ContextClock"

export class BrowserContextClock implements ContextClock {
    readonly #context: AudioContext

    constructor(context: AudioContext) {this.#context = context}

    audibleTimeAt(performanceTime: number): number {
        const {contextTime, performanceTime: stampTime} = this.#context.getOutputTimestamp()
        // the stamp reads zero until the output runs: estimate the audible time from the render clock
        if (isDefined(contextTime) && isDefined(stampTime) && stampTime > 0) {
            return contextTime + (performanceTime - stampTime) / 1000.0
        }
        const outputLatency = this.#context.outputLatency ?? 0.0
        return this.#context.currentTime - outputLatency + (performanceTime - performance.now()) / 1000.0
    }
}
