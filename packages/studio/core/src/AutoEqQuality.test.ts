import {describe, expect, it} from "vitest"
import {AudioData, BiquadCoeff, FFT, Window} from "@opendaw/lib-dsp"
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

type Section = readonly ["shelfLo" | "shelfHi" | "bell", number, number, number]

const buildBiquad = ([type, frequency, q, gainDb]: Section): BiquadCoeff => {
    const coeff = new BiquadCoeff()
    if (type === "shelfLo") {coeff.setLowShelfParams(frequency / SAMPLE_RATE, gainDb)}
    else if (type === "shelfHi") {coeff.setHighShelfParams(frequency / SAMPLE_RATE, gainDb)}
    else {coeff.setPeakingParams(frequency / SAMPLE_RATE, q, gainDb)}
    return coeff
}

const pinkMix = (seconds: number, chain: ReadonlyArray<Section>): AudioData => {
    const numberOfFrames = SAMPLE_RATE * seconds
    const data = AudioData.create(SAMPLE_RATE, numberOfFrames, 1)
    const frame = data.frames[0]
    const random = mulberry32(0x2026)
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
    for (const section of chain) {applyBiquad(frame, buildBiquad(section))}
    return data
}

const revampBiquads = (result: AutoEq.Result): ReadonlyArray<BiquadCoeff> => {
    const q = Math.SQRT1_2
    return [
        new BiquadCoeff().setLowShelfParams(result.lowShelf.frequency / SAMPLE_RATE, result.lowShelf.gainDb),
        new BiquadCoeff().setPeakingParams(result.lowBell.frequency / SAMPLE_RATE, q, result.lowBell.gainDb),
        new BiquadCoeff().setPeakingParams(result.midBell.frequency / SAMPLE_RATE, q, result.midBell.gainDb),
        new BiquadCoeff().setPeakingParams(result.highBell.frequency / SAMPLE_RATE, q, result.highBell.gainDb),
        new BiquadCoeff().setHighShelfParams(result.highShelf.frequency / SAMPLE_RATE, result.highShelf.gainDb)
    ]
}

const corrected = (audio: AudioData, coeffs: ReadonlyArray<BiquadCoeff>): AudioData => {
    const frame = audio.frames[0].slice()
    for (const coeff of coeffs) {applyBiquad(frame, coeff)}
    const out = AudioData.create(SAMPLE_RATE, frame.length, 1)
    out.frames[0].set(frame)
    return out
}

// Independent measurement of a signal's actual tonal balance: RMS deviation (dB) of the energy-per-1/6-
// octave spectrum from its own mean over the musical band. Lower = flatter. Does not use AutoEq internals.
const flatnessDb = (audio: AudioData): number => {
    const size = 4096
    const window = Window.create(Window.Type.Hanning, size)
    const fft = new FFT(size)
    const power = new Float64Array(size >> 1)
    const frame = audio.frames[0]
    let count = 0
    for (let start = 0; start + size <= frame.length; start += size >> 1) {
        const real = new Float32Array(size)
        const imag = new Float32Array(size)
        for (let i = 0; i < size; i++) {real[i] = frame[start + i] * window[i]}
        fft.process(real, imag)
        for (let i = 1; i < power.length; i++) {power[i] += real[i] * real[i] + imag[i] * imag[i]}
        count++
    }
    for (let i = 1; i < power.length; i++) {power[i] /= count}
    const half = Math.pow(2.0, 1.0 / 6.0)
    const values: Array<number> = []
    for (let p = 0; p < 60; p++) {
        const frequency = 35.0 * Math.pow(16000.0 / 35.0, p / 59)
        const lowBin = Math.max(1, Math.floor(frequency / half * size / SAMPLE_RATE))
        const highBin = Math.min(power.length - 1, Math.ceil(frequency * half * size / SAMPLE_RATE))
        let sum = 0.0
        for (let bin = lowBin; bin <= highBin; bin++) {sum += power[bin]}
        values.push(10.0 * Math.log10(sum + 1e-12))
    }
    const mean = values.reduce((accumulator, value) => accumulator + value, 0) / values.length
    return Math.sqrt(values.reduce((accumulator, value) => accumulator + (value - mean) ** 2, 0) / values.length)
}

const loudnessDb = (audio: AudioData): number => {
    const frame = audio.frames[0]
    let sumSquares = 0.0
    for (let i = 0; i < frame.length; i++) {sumSquares += frame[i] * frame[i]}
    return 10.0 * Math.log10(sumSquares / frame.length + 1e-12)
}

const report = (name: string, chain: ReadonlyArray<Section>): number => {
    const audio = pinkMix(5, chain)
    const result = AutoEq.analyze(audio)
    const processed = corrected(audio, revampBiquads(result))
    const before = flatnessDb(audio)
    const after = flatnessDb(processed)
    const levelDelta = loudnessDb(processed) - loudnessDb(audio)
    const bells = [result.lowBell, result.midBell, result.highBell]
        .map(band => `${Math.round(band.frequency)}Hz/${band.gainDb.toFixed(1)}`).join(" ")
    console.log(`[quality] ${name}: ${before.toFixed(2)} -> ${after.toFixed(2)} dB RMS`
        + ` (${Math.round((1 - after / before) * 100)}% flatter); level ${levelDelta >= 0 ? "+" : ""}`
        + `${levelDelta.toFixed(2)} dB; bells ${bells}`)
    expect(Math.abs(levelDelta)).toBeLessThan(0.75) // the correction must stay loudness-neutral (no clipping)
    return after / before
}

describe("AutoEq quality on emulated mixes", () => {
    it("flattens a broadband-messy mix and a resonance-heavy mix", () => {
        const messy = report("messy   ", [
            ["shelfLo", 55, 0, 3.5], ["bell", 230, 0.8, 4.5], ["bell", 520, 1.4, 2.5],
            ["bell", 2600, 1.1, -3.5], ["bell", 3400, 3.5, 4.0], ["shelfHi", 8500, 0, -3.0]
        ])
        const reso = report("resonant", [
            ["bell", 190, 2.5, 5.0], ["bell", 900, 3.0, -4.5], ["bell", 3200, 2.5, 5.5]
        ])
        expect(messy).toBeLessThan(0.8)
        expect(reso).toBeLessThan(0.7)
    })
})
