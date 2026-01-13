import {int} from "@moises-ai/lib-std"

export class LookAhead {
    readonly #buffer: Float32Array
    readonly #delayInSamples: int
    readonly #bufferSize: int

    #writePosition: int = 0
    #numLastPushed: int = 0

    constructor(sampleRate: number, delay: number, blockSize: int) {
        this.#delayInSamples = Math.floor(sampleRate * delay)
        this.#bufferSize = blockSize + this.#delayInSamples
        this.#buffer = new Float32Array(this.#bufferSize)
        this.#writePosition = 0
    }

    process(src: Float32Array, fromIndex: int, toIndex: int): void {
        this.#pushSamples(src, fromIndex, toIndex)
        this.#processSamples()
        this.#readSamples(src, fromIndex, toIndex)
    }

    #pushSamples(src: Float32Array, fromIndex: int, toIndex: int): void {
        for (let i = fromIndex; i < toIndex; i++) {
            this.#buffer[this.#writePosition] = src[i]
            this.#writePosition = (this.#writePosition + 1) % this.#bufferSize
        }
        this.#numLastPushed = toIndex - fromIndex
    }

    #readSamples(dst: Float32Array, fromIndex: int, toIndex: int): void {
        let readPosition = this.#writePosition - this.#numLastPushed - this.#delayInSamples
        if (readPosition < 0) readPosition += this.#bufferSize
        for (let i = fromIndex; i < toIndex; i++) {
            dst[i] = this.#buffer[readPosition]
            readPosition = (readPosition + 1) % this.#bufferSize
        }
    }

    #processSamples(): void {
        let index = this.#writePosition - 1
        if (index < 0) index += this.#bufferSize

        let nextValue = 0.0
        let slope = 0.0

        for (let i = 0; i < this.#numLastPushed; i++) {
            const sample = this.#buffer[index]
            if (sample > nextValue) {
                this.#buffer[index] = nextValue
                nextValue += slope
            } else {
                slope = -sample / this.#delayInSamples
                nextValue = sample + slope
            }
            index = index - 1
            if (index < 0) index += this.#bufferSize
        }

        let procMinimumFound = false
        for (let i = 0; i < this.#delayInSamples && !procMinimumFound; i++) {
            const sample = this.#buffer[index]
            if (sample > nextValue) {
                this.#buffer[index] = nextValue
                nextValue += slope
            } else {
                procMinimumFound = true
                break
            }
            index = index - 1
            if (index < 0) index += this.#bufferSize
        }
    }
}