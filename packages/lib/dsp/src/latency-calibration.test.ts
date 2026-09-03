import {describe, expect, test} from "vitest"
import {
    analyzeBursts,
    crossCorrelate,
    generateMls,
    LatencyCalibrationInput,
    LatencyProbes,
    peakToMeanRatioDb,
    refinePeak
} from "./latency-calibration"

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

describe("LatencyProbes.mls", () => {
    test("renders the sequence of its order, at any rate", () => {
        const probe = LatencyProbes.mls(10)
        expect(Array.from(probe.render(48000))).toEqual(Array.from(generateMls(10)))
        expect(Array.from(probe.render(44100))).toEqual(Array.from(generateMls(10)))
    })
    test("names itself after its order", () => {
        expect(LatencyProbes.mls(10).name).toBe("mls-10")
        expect(LatencyProbes.mls(15).name).toBe("mls-15")
    })
    test("defaults to order 15", () => {
        expect(LatencyProbes.mls().name).toBe("mls-15")
        expect(LatencyProbes.mls().render(48000).length).toBe(32767)
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

describe("analyzeBursts", () => {
    const sampleRate = 48000
    const order = 12 // short MLS keeps the test fast; the routine uses 15
    const mls = generateMls(order)
    const spacingSeconds = mls.length / sampleRate + 0.5
    const captureStartTime = 10.0
    const burstStartTimes = [10.1, 10.1 + spacingSeconds, 10.1 + 2 * spacingSeconds]
    const captureLength = Math.ceil((burstStartTimes[2] + spacingSeconds - captureStartTime) * sampleRate)

    // A linear sweep of the same length, standing in for any deterministic non-MLS probe.
    const chirp = ((): Float32Array => {
        const sweep = new Float32Array(mls.length)
        const duration = sweep.length / sampleRate
        const startHz = 200.0
        const endHz = 8000.0
        for (let index = 0; index < sweep.length; index++) {
            const time = index / sampleRate
            sweep[index] = Math.sin(2.0 * Math.PI * (startHz * time + (endHz - startHz) * time * time / (2.0 * duration)))
        }
        return sweep
    })()

    const synthesize = (delaysSeconds: ReadonlyArray<number>, gains: ReadonlyArray<number> = [1, 1, 1],
                        reference: Float32Array = mls): Float32Array => {
        const capture = new Float32Array(captureLength)
        burstStartTimes.forEach((startTime, burst) => {
            const offset = (startTime - captureStartTime + delaysSeconds[burst]) * sampleRate
            const whole = Math.floor(offset)
            const fraction = offset - whole
            for (let index = 0; index < reference.length; index++) {
                capture[whole + index] += reference[index] * (1 - fraction) * gains[burst]
                capture[whole + index + 1] += reference[index] * fraction * gains[burst]
            }
        })
        return capture
    }
    const input = (capture: Float32Array, reference: Float32Array = mls): LatencyCalibrationInput => ({
        sampleRate, capture, captureStartTime, reference, burstStartTimes,
        maxRoundTripSeconds: 0.6, ratioThresholdDb: 18
    })

    test("recovers the same delay on every burst", () => {
        const analysis = analyzeBursts(input(synthesize([0.0213, 0.0213, 0.0213])))
        expect(analysis.identifiedBursts).toBe(3)
        analysis.delays.forEach(delay => expect(delay).toBeCloseTo(0.0213, 4))
        expect(analysis.roundTripSeconds).toBeCloseTo(0.0213, 4)
        expect(analysis.spreadSeconds).toBeLessThan(0.0001)
        analysis.ratiosDb.forEach(ratio => expect(ratio).toBeGreaterThan(18))
    })
    test("recovers the same delay against a non-MLS reference", () => {
        const analysis = analyzeBursts(input(synthesize([0.0213, 0.0213, 0.0213], [1, 1, 1], chirp), chirp))
        expect(analysis.identifiedBursts).toBe(3)
        analysis.delays.forEach(delay => expect(delay).toBeCloseTo(0.0213, 4))
        expect(analysis.roundTripSeconds).toBeCloseTo(0.0213, 4)
        expect(analysis.spreadSeconds).toBeLessThan(0.0001)
        analysis.ratiosDb.forEach(ratio => expect(ratio).toBeGreaterThan(18))
    })
    test("recovers the same delay through a polarity-inverting loopback", () => {
        const inverted = synthesize([0.0213, 0.0213, 0.0213])
        for (let index = 0; index < inverted.length; index++) {inverted[index] = -inverted[index]}
        const analysis = analyzeBursts(input(inverted))
        expect(analysis.identifiedBursts).toBe(3)
        analysis.delays.forEach(delay => expect(delay).toBeCloseTo(0.0213, 4))
        expect(analysis.roundTripSeconds).toBeCloseTo(0.0213, 4)
        expect(analysis.spreadSeconds).toBeLessThan(0.0001)
        analysis.ratiosDb.forEach(ratio => expect(ratio).toBeGreaterThan(18))
    })
    test("reports the spread when one burst is late", () => {
        const analysis = analyzeBursts(input(synthesize([0.020, 0.020, 0.023])))
        expect(analysis.identifiedBursts).toBe(3)
        expect(analysis.roundTripSeconds).toBeCloseTo(0.020, 4)
        expect(analysis.spreadSeconds).toBeCloseTo(0.003, 4)
    })
    test("a silent burst is not identified and does not enter the median", () => {
        const analysis = analyzeBursts(input(synthesize([0.020, 0.020, 0.020], [1, 0, 1])))
        expect(analysis.identifiedBursts).toBe(2)
        expect(Number.isNaN(analysis.delays[1])).toBe(true)
        expect(analysis.ratiosDb[1]).toBeLessThan(18)
        expect(analysis.roundTripSeconds).toBeCloseTo(0.020, 4)
    })
    test("all silent → nothing identified, NaN round trip", () => {
        const analysis = analyzeBursts(input(new Float32Array(captureLength)))
        expect(analysis.identifiedBursts).toBe(0)
        expect(Number.isNaN(analysis.roundTripSeconds)).toBe(true)
        expect(analysis.spreadSeconds).toBe(0)
    })
    test("a burst that started before the capture's first frame is skipped, not thrown", () => {
        // The calibration's second capture anchor opens after the first burst is already over, so that
        // burst's window begins before the anchor's first frame and only the later bursts are located.
        const delaySeconds = 0.020
        const lateStart = burstStartTimes[0] + mls.length / sampleRate // the first burst's scheduled end
        const droppedFrames = Math.round((lateStart - captureStartTime) * sampleRate)
        const analysis = analyzeBursts({
            sampleRate,
            capture: synthesize([delaySeconds, delaySeconds, delaySeconds]).slice(droppedFrames),
            captureStartTime: lateStart,
            reference: mls, burstStartTimes, maxRoundTripSeconds: 0.6, ratioThresholdDb: 18
        })
        expect(analysis.identifiedBursts).toBe(2)
        expect(Number.isNaN(analysis.delays[0])).toBe(true)
        expect(analysis.ratiosDb[0]).toBe(Number.NEGATIVE_INFINITY)
        expect(analysis.delays[1]).toBeCloseTo(delaySeconds, 4)
        expect(analysis.delays[2]).toBeCloseTo(delaySeconds, 4)
        expect(analysis.roundTripSeconds).toBeCloseTo(delaySeconds, 4)
    })
    test("a capture with no first-frame time identifies nothing", () => {
        // A capture worklet that never saw a quantum carrying channels reports NaN; every burst
        // window is then unlocatable and each is skipped with the same figures a missed burst gets.
        const analysis = analyzeBursts({
            sampleRate,
            capture: synthesize([0.020, 0.020, 0.020]),
            captureStartTime: Number.NaN,
            reference: mls, burstStartTimes, maxRoundTripSeconds: 0.6, ratioThresholdDb: 18
        })
        expect(analysis.identifiedBursts).toBe(0)
        expect(analysis.delays.every(delay => Number.isNaN(delay))).toBe(true)
        expect(analysis.ratiosDb).toEqual(burstStartTimes.map(() => Number.NEGATIVE_INFINITY))
        expect(Number.isNaN(analysis.roundTripSeconds)).toBe(true)
    })
    test("a burst whose window runs past the capture end is skipped, not thrown", () => {
        const short = synthesize([0.020, 0.020, 0.020]).slice(0, Math.floor((burstStartTimes[2] - captureStartTime) * sampleRate) + 100)
        const analysis = analyzeBursts(input(short))
        expect(analysis.identifiedBursts).toBe(2)
    })
})
