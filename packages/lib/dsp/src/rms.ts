import {int} from "@moises-ai/lib-std"

export class RMS {
    readonly #values: Float32Array
    readonly #inv: number

    #index: int
    #sum: number

    constructor(n: int) {
        this.#values = new Float32Array(n)
        this.#inv = 1.0 / n
        this.#index = 0 | 0
        this.#sum = 0.0
    }

    pushPop(x: number): number {
        const squared = x * x
        this.#sum -= this.#values[this.#index]
        this.#sum += squared
        this.#values[this.#index] = squared
        if (++this.#index === this.#values.length) {this.#index = 0}
        return this.#sum <= 0.0 ? 0.0 : Math.sqrt(this.#sum * this.#inv)
    }

    processBlock(buffer: Float32Array, fromIndex: int, toIndex: int): number {
        const values = this.#values
        const len = values.length
        let index = this.#index
        let sum = this.#sum
        for (let i = fromIndex; i < toIndex; i++) {
            const squared = buffer[i] * buffer[i]
            sum += squared - values[index]
            values[index] = squared
            if (++index === len) {index = 0}
        }
        this.#index = index
        this.#sum = sum
        return sum <= 0.0 ? 0.0 : Math.sqrt(sum * this.#inv)
    }

    clear(): void {
        this.#values.fill(0.0)
        this.#sum = 0.0
        this.#index = 0 | 0
    }
}