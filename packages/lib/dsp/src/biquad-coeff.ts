import {assert, clamp, TAU, unitValue} from "@moises-ai/lib-std"

// turns out the following code is producing similar but different frequency responses
// https://chromium.googlesource.com/chromium/blink/+/refs/heads/main/Source/platform/audio/Biquad.cpp
// while this one produces the correct results
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/audio/biquad.cc
// quickly tested all biquad modes

export class BiquadCoeff {
    a1: number = 0.0
    a2: number = 0.0
    b0: number = 0.0
    b1: number = 0.0
    b2: number = 0.0

    constructor() {this.identity()}

    identity(): void {this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)}

    setLowpassParams(cutoff: unitValue, resonance: number = Math.SQRT1_2): this {
        cutoff = clamp(cutoff, 0.0, 1.0)
        if (cutoff >= 0.5) {
            this.setNormalizedCoefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        } else if (cutoff > 0.0) {
            const theta = TAU * cutoff
            const alpha = Math.sin(theta) / (2.0 * resonance)
            const cosw = Math.cos(theta)
            const beta = (1.0 - cosw) / 2.0
            const b0 = beta
            const b1 = 2.0 * beta
            const b2 = beta
            const a0 = 1.0 + alpha
            const a1 = -2.0 * cosw
            const a2 = 1.0 - alpha
            this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
        } else {
            this.setNormalizedCoefficients(0.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        }
        return this
    }

    setHighpassParams(cutoff: unitValue, resonance: number = Math.SQRT1_2): this {
        cutoff = clamp(cutoff, 0.0, 1.0)
        if (cutoff === 1) {
            this.setNormalizedCoefficients(0, 0, 0, 1, 0, 0)
        } else if (cutoff > 0) {
            const theta = TAU * cutoff
            const alpha = Math.sin(theta) / (2 * resonance)
            const cosw = Math.cos(theta)
            const beta = (1 + cosw) / 2
            const b0 = beta
            const b1 = -2 * beta
            const b2 = beta
            const a0 = 1 + alpha
            const a1 = -2 * cosw
            const a2 = 1 - alpha
            this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
        } else {
            this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)
        }
        return this
    }

    setNormalizedCoefficients(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
        const a0_inverse = 1.0 / a0
        this.b0 = b0 * a0_inverse
        this.b1 = b1 * a0_inverse
        this.b2 = b2 * a0_inverse
        this.a1 = a1 * a0_inverse
        this.a2 = a2 * a0_inverse
        return this
    }

    setLowShelfParams(frequency: unitValue, db_gain: number): this {
        frequency = clamp(frequency, 0.0, 1.0)
        const a = Math.pow(10.0, db_gain / 40)
        if (frequency === 1) {
            this.setNormalizedCoefficients(a * a, 0, 0, 1, 0, 0)
        } else if (frequency > 0) {
            const w0 = TAU * frequency
            const s = 1
            const alpha = 0.5 * Math.sin(w0) * Math.sqrt((a + 1 / a) * (1 / s - 1) + 2)
            const k = Math.cos(w0)
            const k2 = 2 * Math.sqrt(a) * alpha
            const a_plus_one = a + 1
            const a_minus_one = a - 1
            const b0 = a * (a_plus_one - a_minus_one * k + k2)
            const b1 = 2 * a * (a_minus_one - a_plus_one * k)
            const b2 = a * (a_plus_one - a_minus_one * k - k2)
            const a0 = a_plus_one + a_minus_one * k + k2
            const a1 = -2 * (a_minus_one + a_plus_one * k)
            const a2 = a_plus_one + a_minus_one * k - k2
            this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
        } else {
            this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)
        }
        return this
    }

    setHighShelfParams(frequency: unitValue, db_gain: number): this {
        frequency = clamp(frequency, 0.0, 1.0)
        const a = Math.pow(10.0, db_gain / 40)
        if (frequency === 1) {
            this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)
        } else if (frequency > 0) {
            const w0 = TAU * frequency
            const s = 1
            const alpha = 0.5 * Math.sin(w0) * Math.sqrt((a + 1 / a) * (1 / s - 1) + 2)
            const k = Math.cos(w0)
            const k2 = 2 * Math.sqrt(a) * alpha
            const a_plus_one = a + 1
            const a_minus_one = a - 1
            const b0 = a * (a_plus_one + a_minus_one * k + k2)
            const b1 = -2 * a * (a_minus_one + a_plus_one * k)
            const b2 = a * (a_plus_one + a_minus_one * k - k2)
            const a0 = a_plus_one - a_minus_one * k + k2
            const a1 = 2 * (a_minus_one - a_plus_one * k)
            const a2 = a_plus_one - a_minus_one * k - k2
            this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
        } else {
            this.setNormalizedCoefficients(a * a, 0, 0, 1, 0, 0)
        }
        return this
    }

    setPeakingParams(frequency: number, q: number, db_gain: number): this {
        frequency = clamp(frequency, 0.0, 1.0)
        q = Math.max(0.0, q)
        const a = Math.pow(10.0, db_gain / 40)
        if (frequency > 0 && frequency < 1) {
            if (q > 0) {
                const w0 = TAU * frequency
                const alpha = Math.sin(w0) / (2 * q)
                const k = Math.cos(w0)
                const b0 = 1 + alpha * a
                const b1 = -2 * k
                const b2 = 1 - alpha * a
                const a0 = 1 + alpha / a
                const a1 = -2 * k
                const a2 = 1 - alpha / a
                this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
            } else {
                this.setNormalizedCoefficients(a * a, 0, 0, 1, 0, 0)
            }
        } else {
            this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)
        }
        return this
    }

    setAllpassParams(frequency: unitValue, q: number): this {
        frequency = clamp(frequency, 0.0, 1.0)
        q = Math.max(0.0, q)
        if (frequency > 0 && frequency < 1) {
            if (q > 0) {
                const w0 = TAU * frequency
                const alpha = Math.sin(w0) / (2 * q)
                const k = Math.cos(w0)
                const b0 = 1 - alpha
                const b1 = -2 * k
                const b2 = 1 + alpha
                const a0 = 1 + alpha
                const a1 = -2 * k
                const a2 = 1 - alpha
                this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
            } else {
                this.setNormalizedCoefficients(-1, 0, 0, 1, 0, 0)
            }
        } else {
            this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)
        }
        return this
    }

    setNotchParams(frequency: unitValue, q: number): this {
        frequency = clamp(frequency, 0.0, 1.0)
        q = Math.max(0.0, q)
        if (frequency > 0 && frequency < 1) {
            if (q > 0) {
                const w0 = TAU * frequency
                const alpha = Math.sin(w0) / (2 * q)
                const k = Math.cos(w0)
                const b0 = 1
                const b1 = -2 * k
                const b2 = 1
                const a0 = 1 + alpha
                const a1 = -2 * k
                const a2 = 1 - alpha
                this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
            } else {
                this.setNormalizedCoefficients(0, 0, 0, 1, 0, 0)
            }
        } else {
            this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)
        }
        return this
    }

    setBandpassParams(frequency: unitValue, q: number): this {
        frequency = Math.max(0.0, frequency)
        q = Math.max(0.0, q)
        if (frequency > 0 && frequency < 1) {
            const w0 = TAU * frequency
            if (q > 0) {
                const alpha = Math.sin(w0) / (2 * q)
                const k = Math.cos(w0)
                const b0 = alpha
                const b1 = 0
                const b2 = -alpha
                const a0 = 1 + alpha
                const a1 = -2 * k
                const a2 = 1 - alpha
                this.setNormalizedCoefficients(b0, b1, b2, a0, a1, a2)
            } else {
                this.setNormalizedCoefficients(1, 0, 0, 1, 0, 0)
            }
        } else {
            this.setNormalizedCoefficients(0, 0, 0, 1, 0, 0)
        }
        return this
    }

    getFrequencyResponse(frequency: Float32Array, magResponse: Float32Array, phaseResponse: Float32Array): void {
        assert(frequency.length === magResponse.length && frequency.length === phaseResponse.length,
            "Array lengths do not match")
        const b0 = this.b0
        const b1 = this.b1
        const b2 = this.b2
        const a1 = this.a1
        const a2 = this.a2
        for (let k = 0; k < frequency.length; ++k) {
            const omega = -Math.PI * 2 * frequency[k]
            const zReal = Math.cos(omega)
            const zImag = Math.sin(omega)
            const numeratorReal = b0 + ((b1 + b2 * zReal) * zReal - b2 * zImag * zImag)
            const numeratorImag = ((b1 + b2 * zReal) * zImag + b2 * zImag * zReal)
            const denominatorReal = 1 + ((a1 + a2 * zReal) * zReal - a2 * zImag * zImag)
            const denominatorImag = ((a1 + a2 * zReal) * zImag + a2 * zImag * zReal)
            const denom = denominatorReal * denominatorReal + denominatorImag * denominatorImag
            const responseReal = (numeratorReal * denominatorReal + numeratorImag * denominatorImag) / denom
            const responseImag = (numeratorImag * denominatorReal - numeratorReal * denominatorImag) / denom
            magResponse[k] = Math.sqrt(responseReal * responseReal + responseImag * responseImag)
            phaseResponse[k] = Math.atan2(responseImag, responseReal)
        }
    }
}