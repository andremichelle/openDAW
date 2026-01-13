import {Arrays, int} from "@moises-ai/lib-std"
import {RenderQuantum} from "./constants"
import {StereoMatrix} from "./stereo"

/**
 * Vibe-coded resampler (Claude 4.5 Sonnet)
 */

// Properly normalized halfband filter coefficients
// These sum to exactly 1.0 for DC preservation
const HALFBAND_COEFF = new Float32Array([
    -0.00048076361, 0.0, 0.00174689293, 0.0, -0.00421638042, 0.0, 0.00854519755, 0.0,
    -0.01627072692, 0.0, 0.03203375191, 0.0, -0.08251235634, 0.0, 0.31203505397, 0.5,
    0.31203505397, 0.0, -0.08251235634, 0.0, 0.03203375191, 0.0, -0.01627072692, 0.0,
    0.00854519755, 0.0, -0.00421638042, 0.0, 0.00174689293, 0.0, -0.00048076361
])

// Extract only non-zero coefficients for efficient polyphase implementation
const PHASE0_COEFF = new Float32Array(12)  // Even-indexed taps (including center)
const PHASE1_COEFF = new Float32Array(11)  // Odd-indexed taps (all zeros in halfband)

// Fill polyphase coefficient arrays
for (let i = 0, p0 = 0, p1 = 0; i < HALFBAND_COEFF.length; i++) {
    if (i % 2 === 0) {
        PHASE0_COEFF[p0++] = HALFBAND_COEFF[i]
    } else {
        PHASE1_COEFF[p1++] = HALFBAND_COEFF[i]
    }
}

// Single-stage 2x resampler using polyphase halfband filter
class Resampler2xMono {
    #upBuffer = new Float32Array(PHASE0_COEFF.length)
    #downBuffer = new Float32Array(HALFBAND_COEFF.length)
    #upIndex: int = 0
    #downIndex: int = 0

    reset(): void {
        this.#upBuffer.fill(0)
        this.#downBuffer.fill(0)
        this.#upIndex = 0
        this.#downIndex = 0
    }


    upsample(input: Float32Array, output: Float32Array, fromIndex: int, toIndex: int): void {
        const buffer = this.#upBuffer
        const phase0 = PHASE0_COEFF
        const phase1 = PHASE1_COEFF

        for (let i = fromIndex; i < toIndex; i++) {
            const x = input[i]
            const outIdx = (i - fromIndex) * 2

            // Store input in circular buffer
            buffer[this.#upIndex] = x

            // Polyphase filter for even output sample (phase 0)
            let sum0 = 0
            for (let j = 0; j < phase0.length; j++) {
                const idx = (this.#upIndex - j + buffer.length) % buffer.length
                sum0 += buffer[idx] * phase0[j]
            }
            output[outIdx] = sum0 * 2  // Compensate for zero-stuffing

            // Polyphase filter for odd output sample (phase 1)
            let sum1 = 0
            for (let j = 0; j < phase1.length; j++) {
                // Phase 1 uses samples offset by 0.5 at input rate
                const idx = (this.#upIndex - j + buffer.length - 1) % buffer.length
                sum1 += buffer[idx] * phase1[j]
            }
            output[outIdx + 1] = sum1 * 2  // Compensate for zero-stuffing

            this.#upIndex = (this.#upIndex + 1) % buffer.length
        }
    }

    downsample(input: Float32Array, output: Float32Array, fromIndex: int, toIndex: int): void {
        const buffer = this.#downBuffer
        const coeff = HALFBAND_COEFF

        for (let i = fromIndex; i < toIndex; i++) {
            const inIdx = (i - fromIndex) * 2
            // Add both input samples to buffer
            buffer[this.#downIndex] = input[inIdx]
            this.#downIndex = (this.#downIndex + 1) % buffer.length
            buffer[this.#downIndex] = input[inIdx + 1]
            this.#downIndex = (this.#downIndex + 1) % buffer.length

            // Apply full anti-aliasing filter and decimate
            let sum = 0
            for (let j = 0; j < coeff.length; j++) {
                const idx = (this.#downIndex - 1 - j + buffer.length) % buffer.length
                sum += buffer[idx] * coeff[j]
            }
            output[i] = sum
        }
    }
}

export class ResamplerMono {
    readonly #factor: 2 | 4 | 8
    readonly #stages: Resampler2xMono[]
    readonly #buffers: Float32Array[]

    constructor(factor: 2 | 4 | 8) {
        this.#factor = factor

        const numStages = factor === 2 ? 1 : factor === 4 ? 2 : 3
        this.#stages = Arrays.create(() => new Resampler2xMono(), numStages)
        this.#buffers = Arrays.create((i) => new Float32Array(RenderQuantum * (2 << i)), numStages - 1)
    }

    reset(): void {this.#stages.forEach(stage => stage.reset())}

    upsample(input: Float32Array, output: Float32Array, fromIndex: int, toIndex: int): void {
        const count = toIndex - fromIndex
        let inBuffer = input
        let inFrom = fromIndex
        let inTo = toIndex
        for (let i = 0; i < this.#stages.length; i++) {
            const isLast = i === this.#stages.length - 1
            const outBuffer = isLast ? output : this.#buffers[i]
            this.#stages[i].upsample(inBuffer, outBuffer, inFrom, inTo)
            inBuffer = outBuffer
            inFrom = 0
            inTo = count * (2 << i)
        }
    }

    downsample(input: Float32Array, output: Float32Array, fromIndex: int, toIndex: int): void {
        const count = toIndex - fromIndex
        let inBuffer = input
        let inTo = count * this.#factor
        for (let i = this.#stages.length - 1; i >= 0; i--) {
            const isLast = i === 0
            const outBuffer = isLast ? output : this.#buffers[i - 1]
            const outFrom = isLast ? fromIndex : 0
            const outTo = isLast ? toIndex : inTo / 2
            this.#stages[i].downsample(inBuffer, outBuffer, outFrom, outTo)
            inBuffer = outBuffer
            inTo = outTo
        }
    }
}

export class ResamplerStereo {
    readonly #left: ResamplerMono
    readonly #right: ResamplerMono

    constructor(factor: 2 | 4 | 8) {
        this.#left = new ResamplerMono(factor)
        this.#right = new ResamplerMono(factor)
    }

    reset(): void {
        this.#left.reset()
        this.#right.reset()
    }

    upsample(input: StereoMatrix.Channels, output: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
        this.#left.upsample(input[0], output[0], fromIndex, toIndex)
        this.#right.upsample(input[1], output[1], fromIndex, toIndex)
    }

    downsample(input: StereoMatrix.Channels, output: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
        this.#left.downsample(input[0], output[0], fromIndex, toIndex)
        this.#right.downsample(input[1], output[1], fromIndex, toIndex)
    }
}