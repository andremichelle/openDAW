import {int} from "@opendaw/lib-std"
import {FFT} from "@opendaw/lib-dsp"

// The delay from the engine rendering a sample to that sound arriving in a recording, measured by playing
// noise bursts out and finding them in what the input captured
export namespace RoundTrip {
    export type Verdict = "ok" | "unsteady" | "no-signal"

    export type Result = {
        readonly verdict: Verdict
        readonly seconds: number
        readonly spreadSeconds: number
        readonly heard: int
        readonly bursts: int
    }

    export type Entry = {
        readonly output: string
        readonly input: string
        readonly sampleRate: number
        readonly seconds: number
        readonly measuredAt: number
    }

    export const MaxSeconds = 0.6
    export const BurstGapSeconds = 0.8
    export const HeardRatioDb = 15.0
    export const SteadySpreadSeconds = 0.0015

    // a maximum length sequence of 2^14 - 1 values: its autocorrelation is a single peak
    export const probe = (): Float32Array<ArrayBuffer> => {
        const length = (1 << 14) - 1
        const values = new Float32Array(length)
        let register = 1
        for (let index = 0; index < length; index++) {
            const bit = register & 1
            values[index] = bit === 1 ? 1.0 : -1.0
            register >>>= 1
            if (bit === 1) {register ^= 0x3802}
        }
        return values
    }

    export type Peak = { readonly lag: number, readonly ratioDb: number }

    // where the probe starts inside the window, refined between samples, and how far the peak stands out
    export const locate = (window: Float32Array, probeValues: Float32Array): Peak => {
        let size = 1
        while (size < window.length + probeValues.length) {size <<= 1}
        const fft = new FFT(size)
        const windowReal = new Float32Array(size)
        const windowImag = new Float32Array(size)
        const probeReal = new Float32Array(size)
        const probeImag = new Float32Array(size)
        windowReal.set(window)
        probeReal.set(probeValues)
        fft.process(windowReal, windowImag)
        fft.process(probeReal, probeImag)
        for (let index = 0; index < size; index++) {
            const real = windowReal[index] * probeReal[index] + windowImag[index] * probeImag[index]
            const imag = windowImag[index] * probeReal[index] - windowReal[index] * probeImag[index]
            windowReal[index] = real
            windowImag[index] = imag
        }
        fft.inverse(windowReal, windowImag)
        const lags = Math.max(1, window.length - probeValues.length + 1)
        let peakIndex = 0
        let peakValue = 0.0
        let energy = 0.0
        for (let index = 0; index < lags; index++) {
            const value = Math.abs(windowReal[index])
            energy += value * value
            if (value > peakValue) {
                peakValue = value
                peakIndex = index
            }
        }
        const mean = (energy - peakValue * peakValue) / Math.max(1, lags - 1)
        const ratioDb = mean > 0.0 ? 10.0 * Math.log10(peakValue * peakValue / mean) : Number.POSITIVE_INFINITY
        if (peakIndex === 0 || peakIndex === lags - 1) {return {lag: peakIndex, ratioDb}}
        const left = Math.abs(windowReal[peakIndex - 1])
        const right = Math.abs(windowReal[peakIndex + 1])
        const denominator = left - 2.0 * peakValue + right
        const shift = denominator === 0.0 ? 0.0 : 0.5 * (left - right) / denominator
        return {lag: peakIndex + shift, ratioDb}
    }

    // `captured` starts at the context time `firstFrameTime`, every burst was emitted at its context time
    export const analyse = (captured: Float32Array, firstFrameTime: number, sampleRate: number,
                            emissions: ReadonlyArray<number>, probeValues: Float32Array): Result => {
        const trips: Array<number> = []
        const windowLength = Math.round(MaxSeconds * sampleRate) + probeValues.length
        for (const emission of emissions) {
            const start = Math.round((emission - firstFrameTime) * sampleRate)
            if (start < 0 || start + windowLength > captured.length) {continue}
            const {lag, ratioDb} = locate(captured.subarray(start, start + windowLength), probeValues)
            if (ratioDb < HeardRatioDb) {continue}
            trips.push((start + lag) / sampleRate + firstFrameTime - emission)
        }
        if (trips.length === 0) {
            return {verdict: "no-signal", seconds: Number.NaN, spreadSeconds: Number.NaN, heard: 0, bursts: emissions.length}
        }
        const sorted = trips.toSorted((a, b) => a - b)
        const seconds = sorted[Math.floor(sorted.length / 2)]
        const spreadSeconds = sorted[sorted.length - 1] - sorted[0]
        const verdict: Verdict = trips.length === emissions.length && spreadSeconds <= SteadySpreadSeconds ? "ok" : "unsteady"
        return {verdict, seconds, spreadSeconds, heard: trips.length, bursts: emissions.length}
    }
}
