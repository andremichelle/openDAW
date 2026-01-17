import {int, nextPowOf2} from "@opendaw/lib-std"
import {FFT} from "./fft"

export class FrequencyDomainConvolver {
    readonly #fftSize: int
    readonly #fft: FFT
    readonly #blockSize: int

    readonly #irReal: Float32Array
    readonly #irImag: Float32Array

    readonly #inputBuffer: Float32Array
    readonly #inputReal: Float32Array
    readonly #inputImag: Float32Array
    readonly #outputReal: Float32Array
    readonly #outputImag: Float32Array
    readonly #overlapBuffer: Float32Array

    #irLength: int = 0
    #inputPosition: int = 0

    constructor(maxIrLength: int, blockSize: int) {
        this.#blockSize = blockSize
        this.#fftSize = nextPowOf2(maxIrLength + blockSize)
        this.#fft = new FFT(this.#fftSize)
        this.#irReal = new Float32Array(this.#fftSize)
        this.#irImag = new Float32Array(this.#fftSize)
        this.#inputBuffer = new Float32Array(this.#fftSize)
        this.#inputReal = new Float32Array(this.#fftSize)
        this.#inputImag = new Float32Array(this.#fftSize)
        this.#outputReal = new Float32Array(this.#fftSize)
        this.#outputImag = new Float32Array(this.#fftSize)
        this.#overlapBuffer = new Float32Array(this.#fftSize)
    }

    get irLength(): int {return this.#irLength}
    get latency(): int {return this.#fftSize - this.#blockSize}

    setImpulseResponse(ir: Float32Array): void {
        this.#irLength = ir.length
        this.#irReal.fill(0.0)
        this.#irImag.fill(0.0)
        for (let i = 0; i < ir.length && i < this.#fftSize; i++) {
            this.#irReal[i] = ir[i]
        }
        this.#fft.process(this.#irReal, this.#irImag)
    }

    clear(): void {
        this.#inputBuffer.fill(0.0)
        this.#overlapBuffer.fill(0.0)
        this.#inputPosition = 0
    }

    process(source: Float32Array, target: Float32Array, fromIndex: int, toIndex: int): void {
        if (this.#irLength === 0) {
            for (let i = fromIndex; i < toIndex; i++) {
                target[i] = 0.0
            }
            return
        }
        for (let i = fromIndex; i < toIndex; i++) {
            this.#inputBuffer[this.#inputPosition] = source[i]
            this.#inputPosition++
            if (this.#inputPosition === this.#blockSize) {
                this.#processBlock()
                this.#inputPosition = 0
            }
            target[i] = this.#overlapBuffer[0]
            this.#shiftOverlapBuffer()
        }
    }

    #processBlock(): void {
        this.#inputReal.fill(0.0)
        this.#inputImag.fill(0.0)
        for (let i = 0; i < this.#blockSize; i++) {
            this.#inputReal[i] = this.#inputBuffer[i]
        }
        this.#fft.process(this.#inputReal, this.#inputImag)
        for (let i = 0; i < this.#fftSize; i++) {
            const a = this.#inputReal[i]
            const b = this.#inputImag[i]
            const c = this.#irReal[i]
            const d = this.#irImag[i]
            this.#outputReal[i] = a * c - b * d
            this.#outputImag[i] = a * d + b * c
        }
        this.#fft.inverse(this.#outputReal, this.#outputImag)
        for (let i = 0; i < this.#fftSize; i++) {
            this.#overlapBuffer[i] += this.#outputReal[i]
        }
    }

    #shiftOverlapBuffer(): void {
        for (let i = 0; i < this.#fftSize - 1; i++) {
            this.#overlapBuffer[i] = this.#overlapBuffer[i + 1]
        }
        this.#overlapBuffer[this.#fftSize - 1] = 0.0
    }
}
