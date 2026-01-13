// Crest Factor calculator
import {int} from "@moises-ai/lib-std"

export class CrestFactor {
    readonly #maxAttackTime: number = 0.08  // 8ms
    readonly #maxReleaseTime: number = 1.0  // 1sec
    readonly #a1: number
    readonly #b1: number

    #attackTimeInSeconds: number = 0.0
    #releaseTimeInSeconds: number = 0.14
    #avgAttackTime: number = 0.0
    #avgReleaseTime: number = 0.14
    #peakState: number = 0.0
    #rmsState: number = 0.0
    #cFactor: number = 0.0

    constructor(sampleRate: number) {
        this.#a1 = Math.exp(-1.0 / (sampleRate * 0.2)) // Calculate alpha for release time of 200 ms
        this.#b1 = 1 - this.#a1
    }

    process(src: Float32Array, fromIndex: int, toIndex: int): void {
        // Init accumulators
        if (this.#peakState === 0.0) {this.#peakState = src[0]}
        if (this.#rmsState === 0.0) {this.#rmsState = src[0]}

        // Reset avg attack/release
        this.#avgAttackTime = 0.0
        this.#avgReleaseTime = 0.0

        // Calculate averages of auto-attack/release times for a single buffer
        for (let i = fromIndex; i < toIndex; ++i) {
            // Square of input signal
            const s = src[i] * src[i]

            // Update peak state
            this.#peakState = Math.max(s, this.#a1 * this.#peakState + this.#b1 * s)

            // Update rms state
            this.#rmsState = this.#a1 * this.#rmsState + this.#b1 * s

            // Calculate squared crest factor
            const c = this.#peakState / this.#rmsState
            this.#cFactor = c > 0.0 ? c : 0.0

            // Calculate ballistics
            if (this.#cFactor > 0.0) {
                this.#attackTimeInSeconds = 2 * (this.#maxAttackTime / this.#cFactor)
                this.#releaseTimeInSeconds = 2 * (this.#maxReleaseTime / this.#cFactor) - this.#attackTimeInSeconds

                // Update avg ballistics
                this.#avgAttackTime += this.#attackTimeInSeconds
                this.#avgReleaseTime += this.#releaseTimeInSeconds
            }
        }

        // Calculate average ballistics
        const n = toIndex - fromIndex
        this.#avgAttackTime /= n
        this.#avgReleaseTime /= n
    }

    getAvgAttack(): number {
        return this.#avgAttackTime
    }

    getAvgRelease(): number {
        return this.#avgReleaseTime
    }
}