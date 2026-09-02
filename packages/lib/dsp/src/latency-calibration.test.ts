import {describe, expect, test} from "vitest"
import {crossCorrelate, generateMls, peakToMeanRatioDb, refinePeak} from "./latency-calibration"

describe("generateMls", () => {
    test("has length 2^order − 1 and values ±1", () => {
        const mls = generateMls(10)
        expect(mls.length).toBe(1023)
        for (const value of mls) {expect(Math.abs(value)).toBe(1)}
    })
    test("is balanced: one more +1 than −1", () => {
        const mls = generateMls(10)
        let sum = 0
        for (const value of mls) {sum += value}
        expect(sum).toBe(1)
    })
    test("circular autocorrelation is N at lag 0 and −1 elsewhere", () => {
        const order = 10
        const mls = generateMls(order)
        const length = mls.length
        const autocorrelation = (lag: number): number => {
            let sum = 0
            for (let index = 0; index < length; index++) {
                sum += mls[index] * mls[(index + lag) % length]
            }
            return sum
        }
        expect(autocorrelation(0)).toBe(length)
        for (const lag of [1, 2, 7, 100, 511, 1022]) {expect(autocorrelation(lag)).toBe(-1)}
    })
    test("is deterministic", () => {
        expect(Array.from(generateMls(12))).toEqual(Array.from(generateMls(12)))
    })
})

const delayed = (reference: Float32Array, delaySamples: number, totalLength: number, gain = 1.0): Float32Array => {
    const out = new Float32Array(totalLength)
    const whole = Math.floor(delaySamples)
    const fraction = delaySamples - whole
    for (let index = 0; index < reference.length; index++) {
        // linear interpolation between neighbouring output samples for a fractional delay
        const target = index + whole
        if (target < totalLength) {out[target] += reference[index] * (1 - fraction) * gain}
        if (target + 1 < totalLength) {out[target + 1] += reference[index] * fraction * gain}
    }
    return out
}

describe("crossCorrelate", () => {
    const reference = generateMls(10)
    test("peaks at the integer delay", () => {
        const segment = delayed(reference, 137, 2048)
        const correlation = crossCorrelate(segment, reference, 400)
        let best = 0
        for (let lag = 1; lag <= 400; lag++) {if (correlation[lag] > correlation[best]) {best = lag}}
        expect(best).toBe(137)
        expect(correlation[137]).toBeCloseTo(reference.length, 0)
    })
    test("matches the direct definition for a few lags", () => {
        const segment = delayed(reference, 5, 1400)
        const correlation = crossCorrelate(segment, reference, 20)
        for (const lag of [0, 3, 5, 9]) {
            let direct = 0
            for (let index = 0; index < reference.length; index++) {direct += segment[index + lag] * reference[index]}
            expect(correlation[lag]).toBeCloseTo(direct, 2)
        }
    })
    test("recovers a fractional delay within 0.25 sample after refinement", () => {
        const segment = delayed(reference, 137.3, 2048)
        const correlation = crossCorrelate(segment, reference, 400)
        let best = 0
        for (let lag = 1; lag <= 400; lag++) {if (correlation[lag] > correlation[best]) {best = lag}}
        // `delayed()` synthesizes the fractional shift by linear interpolation, which gives the
        // correlation peak a triangular rather than parabolic shape, hence the 0.25 sample bound
        expect(Math.abs(best + refinePeak(correlation, best) - 137.3)).toBeLessThan(0.25)
    })
    test("still locates the peak at 0 dB SNR with a strong ratio", () => {
        const segment = delayed(reference, 137, 2048)
        let seed = 12345
        const random = (): number => {seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff * 2 - 1}
        for (let index = 0; index < segment.length; index++) {segment[index] += random()}
        const correlation = crossCorrelate(segment, reference, 400)
        let best = 0
        for (let lag = 1; lag <= 400; lag++) {if (correlation[lag] > correlation[best]) {best = lag}}
        expect(best).toBe(137)
        expect(peakToMeanRatioDb(correlation, best)).toBeGreaterThan(18)
    })
    test("a delayed attenuated copy does not move the peak", () => {
        const segment = delayed(reference, 137, 2048)
        const echo = delayed(reference, 190, 2048, 0.5)
        for (let index = 0; index < segment.length; index++) {segment[index] += echo[index]}
        const correlation = crossCorrelate(segment, reference, 400)
        let best = 0
        for (let lag = 1; lag <= 400; lag++) {if (correlation[lag] > correlation[best]) {best = lag}}
        expect(best).toBe(137)
    })
})

describe("refinePeak", () => {
    test("returns 0 for a symmetric peak and the parabola vertex otherwise", () => {
        // vertex of the parabola through the three points, expressed as an offset from the centre index
        expect(refinePeak(new Float32Array([1, 3, 1]), 1)).toBeCloseTo(0, 6)
        expect(refinePeak(new Float32Array([2, 3, 1]), 1)).toBeCloseTo(-1 / 6, 6)
        expect(refinePeak(new Float32Array([1, 3, 2]), 1)).toBeCloseTo(1 / 6, 6)
    })
    test("returns 0 at the array edges", () => {
        expect(refinePeak(new Float32Array([3, 1, 1]), 0)).toBe(0)
        expect(refinePeak(new Float32Array([1, 1, 3]), 2)).toBe(0)
    })
})

describe("peakToMeanRatioDb", () => {
    test("is large for a lone peak and small for flat data", () => {
        const lone = new Float32Array(1000).fill(0.01)
        lone[400] = 1
        expect(peakToMeanRatioDb(lone, 400)).toBeGreaterThan(30)
        const flat = new Float32Array(1000).fill(1)
        expect(peakToMeanRatioDb(flat, 400)).toBeCloseTo(0, 6)
    })
})
