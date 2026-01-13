import {int, nextPowOf2} from "@moises-ai/lib-std"

export class Delay {
    readonly #delaySize: int
    readonly #delayMask: int
    readonly #delayBuffer: Float32Array
    readonly #interpolationLength: int

    #writePosition: int = 0 | 0
    #currentOffset: number = 0.0
    #targetOffset: number = 0.0
    #deltaOffset: number = 0.0
    #alphaPosition: int = 0 | 0
    #processed: boolean = false
    #interpolating: boolean = false

    constructor(maxFrames: int, interpolationLength: int) {
        const pow2Size = nextPowOf2(maxFrames)
        this.#delaySize = pow2Size
        this.#delayMask = pow2Size - 1
        this.#delayBuffer = new Float32Array(pow2Size)
        this.#interpolationLength = interpolationLength
    }

    clear(): void {
        this.#writePosition = 0
        if (this.#processed) {
            this.#delayBuffer.fill(0.0)
            this.#processed = false
        }
        this.#initDelayTime()
    }

    set offset(value: number) {
        if (value < 0 || value >= this.#delaySize) {
            throw new Error(`MonoDelay offset ${value} out of bounds [0, ${this.#delaySize})`)
        }
        this.#targetOffset = value
        if (this.#processed) {
            this.#updateDelayTime()
        } else {
            this.#initDelayTime()
        }
    }

    get offset(): number {
        return this.#targetOffset
    }

    process(target: Float32Array, source: Float32Array, fromIndex: int, toIndex: int): void {
        if (this.#interpolating) {
            this.#processInterpolate(target, source, fromIndex, toIndex)
        } else {
            this.#processNonInterpolate(target, source, fromIndex, toIndex)
        }
        this.#processed = true
    }

    #initDelayTime(): void {
        this.#currentOffset = this.#targetOffset
        this.#alphaPosition = 0
        this.#interpolating = false
    }

    #updateDelayTime(): void {
        if (this.#targetOffset !== this.#currentOffset) {
            this.#alphaPosition = this.#interpolationLength
            this.#deltaOffset = (this.#targetOffset - this.#currentOffset) / this.#alphaPosition
            this.#interpolating = true
        }
    }

    #processNonInterpolate(target: Float32Array, source: Float32Array, fromIndex: int, toIndex: int): void {
        const delayBuffer = this.#delayBuffer
        const delayMask = this.#delayMask
        let writePosition = this.#writePosition
        let readPosition = writePosition - Math.floor(this.#currentOffset)
        if (readPosition < 0) {
            readPosition += this.#delaySize
        }

        for (let i = fromIndex; i < toIndex; ++i) {
            delayBuffer[writePosition] = source[i]
            target[i] = delayBuffer[readPosition]
            readPosition = (readPosition + 1) & delayMask
            writePosition = (writePosition + 1) & delayMask
        }
        this.#writePosition = writePosition
    }

    #processInterpolate(target: Float32Array, source: Float32Array, fromIndex: int, toIndex: int): void {
        const delayBuffer = this.#delayBuffer
        const delayMask = this.#delayMask
        let writePosition = this.#writePosition

        for (let i = fromIndex; i < toIndex; ++i) {
            if (this.#alphaPosition > 0) {
                this.#currentOffset += this.#deltaOffset
                this.#alphaPosition--
            } else {
                this.#currentOffset = this.#targetOffset
                this.#interpolating = false
            }

            delayBuffer[writePosition] = source[i]

            let readPosition = writePosition - this.#currentOffset
            if (readPosition < 0) {
                readPosition += this.#delaySize
            }

            const readPositionInt = Math.floor(readPosition)
            const alpha = readPosition - readPositionInt
            const read0 = delayBuffer[readPositionInt]
            target[i] = read0 + alpha * (delayBuffer[(readPositionInt + 1) & delayMask] - read0)
            writePosition = (writePosition + 1) & delayMask
        }
        this.#writePosition = writePosition
    }
}
