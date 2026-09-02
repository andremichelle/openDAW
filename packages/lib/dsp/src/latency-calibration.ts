/**
 * Input-latency calibration analysis: an MLS probe located by cross-correlation.
 *
 * The probe and its trust figure follow:
 *   Gil Panal, J. M., Richard, G., & David, A. (2025). A Maximum Length Sequence–Based Method for
 *   Robust Round-Trip Latency Estimation in online Digital Audio Workstations.
 *   In Proceedings of the Web Audio Conference (WAC 2025). https://doi.org/10.5281/zenodo.17642262
 *   Reference implementation: https://github.com/gilpanal/weblatencytest (MIT)
 * Taken from that work: the MLS probe, locating it by the cross-correlation peak, and the
 * peak-to-mean ratio as the gate for a trustworthy estimate. Different here: the burst's emission
 * time and the capture's first-frame time are both AudioContext clock readings, so the delay is
 * measured against the engine's own clock rather than against MediaRecorder.start(). No code is
 * copied from that repository.
 */
import {int} from "@opendaw/lib-std"
import {FFT} from "./fft"

/** Primitive-polynomial taps per register length; x^n + x^a + … + 1 with the constant term implied. */
export const MLS_TAPS: ReadonlyMap<int, ReadonlyArray<int>> = new Map<int, ReadonlyArray<int>>([
    [10, [10, 7]],
    [11, [11, 9]],
    [12, [12, 11, 10, 4]],
    [13, [13, 12, 11, 8]],
    [14, [14, 13, 12, 2]],
    [15, [15, 14]],
    [16, [16, 15, 13, 4]]
])

/** A maximum-length sequence of the given register order as ±1 samples, length 2^order − 1. */
export const generateMls = (order: int): Float32Array => {
    const taps = MLS_TAPS.get(order)
    if (taps === undefined) {throw new Error(`No MLS taps for order ${order}`)}
    const length = (1 << order) - 1
    const sequence = new Float32Array(length)
    let register = (1 << order) - 1 // all ones; any non-zero seed works
    for (let index = 0; index < length; index++) {
        // Fibonacci form shifting towards bit 0: the register holds the last `order` outputs with the
        // oldest in bit 0, so the exponent x^tap sits at bit `order - tap` and the implied constant
        // term is bit 0 itself. The feedback becomes the output `order` steps later.
        sequence[index] = (register & 1) === 1 ? 1.0 : -1.0
        let feedback = 0
        for (const tap of taps) {feedback ^= (register >>> (order - tap)) & 1}
        register = (register >>> 1) | (feedback << (order - 1))
    }
    return sequence
}

const nextPowerOfTwo = (value: int): int => 1 << Math.ceil(Math.log2(value))

/**
 * result[lag] = Σ_n segment[n + lag] · reference[n], for lag in [0, maxLag], computed through an FFT
 * of size ≥ segment.length + reference.length so the circular correlation carries no wrap-around.
 */
export const crossCorrelate = (segment: Float32Array, reference: Float32Array, maxLag: int): Float32Array => {
    const size = nextPowerOfTwo(segment.length + reference.length)
    const fft = new FFT(size)
    const segmentReal = new Float32Array(size)
    const segmentImag = new Float32Array(size)
    const referenceReal = new Float32Array(size)
    const referenceImag = new Float32Array(size)
    segmentReal.set(segment)
    referenceReal.set(reference)
    fft.process(segmentReal, segmentImag)
    fft.process(referenceReal, referenceImag)
    // S · conj(R)
    for (let bin = 0; bin < size; bin++) {
        const real = segmentReal[bin] * referenceReal[bin] + segmentImag[bin] * referenceImag[bin]
        const imag = segmentImag[bin] * referenceReal[bin] - segmentReal[bin] * referenceImag[bin]
        segmentReal[bin] = real
        segmentImag[bin] = imag
    }
    fft.inverse(segmentReal, segmentImag)
    return segmentReal.slice(0, Math.min(maxLag + 1, size))
}

/** Sub-sample offset of the vertex of the parabola through the peak and its two neighbours. */
export const refinePeak = (correlation: Float32Array, index: int): number => {
    if (index <= 0 || index >= correlation.length - 1) {return 0.0}
    const left = correlation[index - 1]
    const centre = correlation[index]
    const right = correlation[index + 1]
    const denominator = left - 2.0 * centre + right
    return denominator === 0.0 ? 0.0 : 0.5 * (left - right) / denominator
}

/** 10·log10 of the peak's power over the mean power of every other lag. */
export const peakToMeanRatioDb = (correlation: Float32Array, index: int): number => {
    const peakPower = correlation[index] * correlation[index]
    let sum = 0.0
    for (let lag = 0; lag < correlation.length; lag++) {
        if (lag !== index) {sum += correlation[lag] * correlation[lag]}
    }
    const meanPower = sum / Math.max(1, correlation.length - 1)
    return meanPower === 0.0 ? Number.POSITIVE_INFINITY : 10.0 * Math.log10(peakPower / meanPower)
}

export interface LatencyCalibrationInput {
    sampleRate: number
    capture: Float32Array
    captureStartTime: number
    mlsOrder: int
    burstStartTimes: ReadonlyArray<number>
    maxRoundTripSeconds: number
    ratioThresholdDb: number
}

export interface LatencyCalibrationAnalysis {
    delays: ReadonlyArray<number>
    ratiosDb: ReadonlyArray<number>
    roundTripSeconds: number
    spreadSeconds: number
    identifiedBursts: int
}

export interface LatencyCalibrationProtocol {
    analyze(input: LatencyCalibrationInput): Promise<LatencyCalibrationAnalysis>
}

const median = (values: ReadonlyArray<number>): number => {
    const sorted = [...values].sort((left, right) => left - right)
    const middle = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle])
}

/** Locates each scheduled burst in the capture and reduces the per-burst delays to one round trip. */
export const analyzeBursts = (input: LatencyCalibrationInput): LatencyCalibrationAnalysis => {
    const {sampleRate, capture, captureStartTime, mlsOrder, burstStartTimes, maxRoundTripSeconds, ratioThresholdDb} = input
    const mls = generateMls(mlsOrder)
    const maxLag = Math.ceil(maxRoundTripSeconds * sampleRate)
    const delays: Array<number> = []
    const ratiosDb: Array<number> = []
    for (const startTime of burstStartTimes) {
        const startFrame = Math.round((startTime - captureStartTime) * sampleRate)
        // The search window reaches maxLag past the probe so a late burst is still inside it; a
        // capture that ends first is clipped, not rejected — only the probe itself must fit.
        if (startFrame < 0 || startFrame + mls.length > capture.length) {
            delays.push(Number.NaN)
            ratiosDb.push(Number.NEGATIVE_INFINITY)
            continue
        }
        const endFrame = Math.min(startFrame + mls.length + maxLag, capture.length)
        const correlation = crossCorrelate(capture.subarray(startFrame, endFrame), mls, maxLag)
        let peak = 0
        for (let lag = 1; lag < correlation.length; lag++) {if (correlation[lag] > correlation[peak]) {peak = lag}}
        const ratio = peakToMeanRatioDb(correlation, peak)
        ratiosDb.push(ratio)
        // A silent window correlates to exactly zero, and peakToMeanRatioDb's zero-mean branch
        // reports that as +Infinity — excluded here alongside every ratio under threshold.
        delays.push(Number.isFinite(ratio) && ratio >= ratioThresholdDb
            ? (peak + refinePeak(correlation, peak)) / sampleRate : Number.NaN)
    }
    const identified = delays.filter(delay => !Number.isNaN(delay))
    const roundTripSeconds = identified.length === 0 ? Number.NaN : median(identified)
    const spreadSeconds = identified.length <= 1 ? 0.0
        : Math.max(...identified.map(delay => Math.abs(delay - roundTripSeconds)))
    return {delays, ratiosDb, roundTripSeconds, spreadSeconds, identifiedBursts: identified.length}
}
