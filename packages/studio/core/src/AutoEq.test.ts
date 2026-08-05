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

// Pink noise (Paul Kellet) — the reference tonal balance, which reads flat in energy-per-octave.
const pink = (seconds: number, seed: number = 0x1234): AudioData => {
    const numberOfFrames = SAMPLE_RATE * seconds
    const data = AudioData.create(SAMPLE_RATE, numberOfFrames, 1)
    const frame = data.frames[0]
    const random = mulberry32(seed)
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
    return data
}

const bands = (result: AutoEq.Result) =>
    [result.lowShelf, result.lowBell, result.midBell, result.highBell, result.highShelf]

describe("AutoEq.analyze", () => {
    it("leaves the mid-band of a pink-ish mix nearly untouched", () => {
        const result = AutoEq.analyze(pink(3))
        for (const band of [result.lowBell, result.midBell, result.highBell]) {
            expect(Math.abs(band.gainDb)).toBeLessThan(2.5)
        }
    })

    it("cuts a resonant peak sitting above the reference", () => {
        const audio = pink(3)
        const frame = audio.frames[0]
        applyBiquad(frame, new BiquadCoeff().setPeakingParams(300.0 / SAMPLE_RATE, 1.0, 6.0))
        const result = AutoEq.analyze(audio)
        expect(result.lowBell.gainDb).toBeLessThan(-1.5)
    })

    it("keeps every section within the gentle clamp", () => {
        const audio = pink(3)
        const frame = audio.frames[0]
        applyBiquad(frame, new BiquadCoeff().setPeakingParams(300.0 / SAMPLE_RATE, 1.0, 18.0))
        const result = AutoEq.analyze(audio, {maxGainDb: 4.5})
        for (const band of bands(result)) {expect(Math.abs(band.gainDb)).toBeLessThanOrEqual(4.5 + 1e-6)}
    })

    it("returns a flat (no-op) correction for a silent project", () => {
        const silent = AudioData.create(SAMPLE_RATE, SAMPLE_RATE, 1)
        const result = AutoEq.analyze(silent)
        for (const band of bands(result)) {expect(band.gainDb).toBe(0)}
    })

    it("tilts brighter when asked: highs lifted, lows lowered", () => {
        const result = AutoEq.analyze(pink(3), {tiltDbPerOctave: 3.0})
        expect(result.highShelf.gainDb).toBeGreaterThan(result.lowShelf.gainDb)
        expect(result.highShelf.gainDb).toBeGreaterThan(0)
        expect(result.lowShelf.gainDb).toBeLessThan(0)
    })
})

export const applyBiquad = (frame: Float32Array, coeff: BiquadCoeff): void => {
    const {b0, b1, b2, a1, a2} = coeff
    let x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
    for (let i = 0; i < frame.length; i++) {
        const x0 = frame[i]
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x0; y2 = y1; y1 = y0
        frame[i] = y0
    }
}
