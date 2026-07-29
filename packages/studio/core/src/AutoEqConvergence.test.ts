import {describe, expect, it} from "vitest"
import {AudioData, BiquadCoeff} from "@opendaw/lib-dsp"
import {AutoEq} from "./AutoEq"

const SAMPLE_RATE = 48000

const mulberry32 = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const applyBiquad = (frame: Float32Array, coeff: BiquadCoeff): void => {
    const {b0, b1, b2, a1, a2} = coeff
    let x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
    for (let i = 0; i < frame.length; i++) {
        const x0 = frame[i]
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x0; y2 = y1; y1 = y0
        frame[i] = y0
    }
}

// Apply the fitted Revamp bands exactly as the device would, so a re-analysis sees the corrected spectrum.
const applyCorrection = (audio: AudioData, result: AutoEq.Result): AudioData => {
    const frame = audio.frames[0].slice()
    const q = Math.SQRT1_2
    applyBiquad(frame, new BiquadCoeff().setLowShelfParams(result.lowShelf.frequency / SAMPLE_RATE, result.lowShelf.gainDb))
    applyBiquad(frame, new BiquadCoeff().setPeakingParams(result.lowBell.frequency / SAMPLE_RATE, q, result.lowBell.gainDb))
    applyBiquad(frame, new BiquadCoeff().setPeakingParams(result.midBell.frequency / SAMPLE_RATE, q, result.midBell.gainDb))
    applyBiquad(frame, new BiquadCoeff().setPeakingParams(result.highBell.frequency / SAMPLE_RATE, q, result.highBell.gainDb))
    applyBiquad(frame, new BiquadCoeff().setHighShelfParams(result.highShelf.frequency / SAMPLE_RATE, result.highShelf.gainDb))
    const corrected = AudioData.create(SAMPLE_RATE, frame.length, 1)
    corrected.frames[0].set(frame)
    return corrected
}

const totalGain = (result: AutoEq.Result): number =>
    Math.abs(result.lowShelf.gainDb) + Math.abs(result.lowBell.gainDb) + Math.abs(result.midBell.gainDb)
    + Math.abs(result.highBell.gainDb) + Math.abs(result.highShelf.gainDb)

describe("AutoEq convergence", () => {
    it("a second pass over the corrected mix collapses to near-neutral", () => {
        const random = mulberry32(0x51)
        const numberOfFrames = SAMPLE_RATE * 4
        const audio = AudioData.create(SAMPLE_RATE, numberOfFrames, 1)
        const frame = audio.frames[0]
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
        for (let i = 0; i < numberOfFrames; i++) {
            const white = random() * 2 - 1
            b0 = 0.99886 * b0 + white * 0.0555179
            b1 = 0.99332 * b1 + white * 0.0750759
            b2 = 0.96900 * b2 + white * 0.1538520
            b3 = 0.86650 * b3 + white * 0.3104856
            b4 = 0.55000 * b4 + white * 0.5329522
            b5 = -0.7616 * b5 - white * 0.0168980
            frame[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
            b6 = white * 0.115926
        }
        applyBiquad(frame, new BiquadCoeff().setPeakingParams(300.0 / SAMPLE_RATE, 1.0, 5.0))
        applyBiquad(frame, new BiquadCoeff().setPeakingParams(5000.0 / SAMPLE_RATE, 1.0, 4.0))
        const first = AutoEq.analyze(audio)
        const second = AutoEq.analyze(applyCorrection(audio, first))
        const firstTotal = totalGain(first)
        const secondTotal = totalGain(second)
        expect(firstTotal).toBeGreaterThan(3.0)
        expect(secondTotal).toBeLessThan(firstTotal * 0.35)
    })
})
