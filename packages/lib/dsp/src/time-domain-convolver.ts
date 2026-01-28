import {int, nextPowOf2} from "@opendaw/lib-std"

export class TimeDomainConvolver {
    readonly #maxIrLength: int
    readonly #historySize: int
    readonly #historyMask: int
    readonly #history: Float32Array
    readonly #ir: Float32Array

    #writePosition: int = 0
    #irLength: int = 0

    constructor(maxIrLength: int) {
        this.#maxIrLength = maxIrLength
        this.#historySize = nextPowOf2(maxIrLength)
        this.#historyMask = this.#historySize - 1
        this.#history = new Float32Array(this.#historySize)
        this.#ir = new Float32Array(maxIrLength)
    }

    get irLength(): int {return this.#irLength}
    get latency(): int {return 0}

    setImpulseResponse(ir: Float32Array): void {
        const length = Math.min(ir.length, this.#maxIrLength)
        this.#irLength = length
        for (let i = 0; i < length; i++) {
            this.#ir[i] = ir[i]
        }
        for (let i = length; i < this.#maxIrLength; i++) {
            this.#ir[i] = 0.0
        }
    }

    clear(): void {
        this.#history.fill(0.0)
        this.#writePosition = 0
    }

    process(source: Float32Array, target: Float32Array, fromIndex: int, toIndex: int): void {
        const history = this.#history
        const historyMask = this.#historyMask
        const ir = this.#ir
        const irLength = this.#irLength
        if (irLength === 0) {
            for (let i = fromIndex; i < toIndex; i++) {
                target[i] = 0.0
            }
            return
        }
        for (let i = fromIndex; i < toIndex; i++) {
            history[this.#writePosition] = source[i]
            let sum = 0.0
            let readPos = this.#writePosition
            for (let j = 0; j < irLength; j++) {
                sum += history[readPos] * ir[j]
                readPos = (readPos - 1) & historyMask
            }
            target[i] = sum
            this.#writePosition = (this.#writePosition + 1) & historyMask
        }
    }
}
