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
    #position: int = 0

    constructor(maxIrLength: int, blockSize: int) {
        this.#blockSize = blockSize
        this.#fftSize = nextPowOf2(maxIrLength + blockSize)
        this.#fft = new FFT(this.#fftSize)
        this.#irReal = new Float32Array(this.#fftSize)
        this.#irImag = new Float32Array(this.#fftSize)
        this.#inputBuffer = new Float32Array(this.#blockSize)
        this.#inputReal = new Float32Array(this.#fftSize)
        this.#inputImag = new Float32Array(this.#fftSize)
        this.#outputReal = new Float32Array(this.#fftSize)
        this.#outputImag = new Float32Array(this.#fftSize)
        this.#overlapBuffer = new Float32Array(this.#fftSize + this.#blockSize)
    }

    get irLength(): int {return this.#irLength}
    get latency(): int {return this.#blockSize}

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
        this.#position = 0
    }

    process(source: Float32Array, target: Float32Array, fromIndex: int, toIndex: int): void {
        if (this.#irLength === 0) {
            for (let i = fromIndex; i < toIndex; i++) {
                target[i] = 0.0
            }
            return
        }
        for (let i = fromIndex; i < toIndex; i++) {
            // Store input sample
            this.#inputBuffer[this.#position] = source[i]
            this.#position++
            // When we've collected a full block, process it BEFORE reading output
            if (this.#position === this.#blockSize) {
                this.#processBlock()
                this.#position = 0
            }
            // Output from overlap buffer (shifted by processBlock)
            target[i] = this.#overlapBuffer[this.#position]
        }
    }

    #processBlock(): void {
        // Zero-pad input to FFT size
        this.#inputReal.fill(0.0)
        this.#inputImag.fill(0.0)
        for (let i = 0; i < this.#blockSize; i++) {
            this.#inputReal[i] = this.#inputBuffer[i]
        }
        // Forward FFT
        this.#fft.process(this.#inputReal, this.#inputImag)
        // Complex multiplication in frequency domain
        for (let i = 0; i < this.#fftSize; i++) {
            const a = this.#inputReal[i]
            const b = this.#inputImag[i]
            const c = this.#irReal[i]
            const d = this.#irImag[i]
            this.#outputReal[i] = a * c - b * d
            this.#outputImag[i] = a * d + b * c
        }
        // Inverse FFT
        this.#fft.inverse(this.#outputReal, this.#outputImag)
        // Shift overlap buffer by blockSize
        for (let i = 0; i < this.#fftSize; i++) {
            this.#overlapBuffer[i] = this.#overlapBuffer[i + this.#blockSize]
        }
        // Zero the shifted-in portion
        for (let i = this.#fftSize; i < this.#fftSize + this.#blockSize; i++) {
            this.#overlapBuffer[i] = 0.0
        }
        // Add new convolution result (overlap-add)
        for (let i = 0; i < this.#fftSize; i++) {
            this.#overlapBuffer[i] += this.#outputReal[i]
        }
    }
}
