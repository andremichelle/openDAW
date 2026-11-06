import {Arrays, Func, int} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"

export class QuantumStepper {
    readonly #numberOfChannels: int
    readonly #quantum: Float32Array[]

    #read: int = RenderQuantum

    constructor(numberOfChannels: int) {
        this.#numberOfChannels = numberOfChannels
        this.#quantum = Arrays.create(() => new Float32Array(RenderQuantum), numberOfChannels)
    }

    // render fills one quantum and returns how many of its leading frames to drop
    step(numSamples: int, render: Func<Float32Array[], int>): Float32Array[] {
        const result: Float32Array[] = Arrays.create(() => new Float32Array(numSamples), this.#numberOfChannels)
        let offset = 0 | 0
        while (offset < numSamples) {
            if (this.#read === RenderQuantum) {this.#read = render(this.#quantum)}
            const toCopy = Math.min(numSamples - offset, RenderQuantum - this.#read)
            for (let channel = 0; channel < this.#numberOfChannels; channel++) {
                result[channel].set(this.#quantum[channel].subarray(this.#read, this.#read + toCopy), offset)
            }
            this.#read += toCopy
            offset += toCopy
        }
        return result
    }

    clear(): void {this.#read = RenderQuantum}
}
