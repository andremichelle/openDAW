import {describe, expect, it} from "vitest"
import {downsampleTo11025} from "./TempoDetectionTask"

const TARGET_SR = 11025

const sine = (frequency: number, sampleRate: number, seconds: number): Float32Array => {
    const frames = Math.floor(sampleRate * seconds)
    const audio = new Float32Array(frames)
    for (let index = 0; index < frames; index++) {
        audio[index] = Math.sin(2.0 * Math.PI * frequency * index / sampleRate)
    }
    return audio
}

// Magnitude at one frequency (Goertzel), normalized so a full-scale sine reads ~0.5.
const magnitudeAt = (audio: Float32Array, frequency: number, sampleRate: number): number => {
    const omega = 2.0 * Math.PI * frequency / sampleRate
    const coeff = 2.0 * Math.cos(omega)
    let previous = 0.0
    let beforePrevious = 0.0
    for (let index = 0; index < audio.length; index++) {
        const current = audio[index] + coeff * previous - beforePrevious
        beforePrevious = previous
        previous = current
    }
    const real = previous - beforePrevious * Math.cos(omega)
    const imaginary = beforePrevious * Math.sin(omega)
    return Math.sqrt(real * real + imaginary * imaginary) / audio.length
}

const rms = (audio: Float32Array): number =>
    Math.sqrt(audio.reduce((sum, value) => sum + value * value, 0.0) / audio.length)

describe("downsampleTo11025", () => {
    it("passes 11025 Hz material through untouched", () => {
        const audio = sine(1000, TARGET_SR, 1.0)
        expect(downsampleTo11025(audio, TARGET_SR)).toBe(audio)
    })

    it.each([22050, 44100, 88200, 48000, 32000, 96000])
    ("resamples %i Hz to 11025 Hz", sampleRate => {
        const output = downsampleTo11025(sine(1000, sampleRate, 2.0), sampleRate)
        const expectedLength = 2.0 * TARGET_SR
        expect(Math.abs(output.length - expectedLength)).toBeLessThan(TARGET_SR * 0.01)
    })

    // The regression: 48000 Hz is not a power-of-two multiple of 11025, and every openDAW sample
    // decodes at the AudioContext rate, so this is the rate the studio actually asks for.
    it.each([48000, 44100, 32000, 96000])
    ("keeps a 1 kHz tone intact at %i Hz", sampleRate => {
        const output = downsampleTo11025(sine(1000, sampleRate, 2.0), sampleRate)
        expect(magnitudeAt(output, 1000, TARGET_SR)).toBeGreaterThan(0.4)
        expect(rms(output)).toBeGreaterThan(0.6)
    })

    // Without the low-pass before the fractional step, 7 kHz at 48000 folds back to ~4 kHz and lands
    // inside the mel bands the model reads.
    it.each([48000, 32000])
    ("rejects content above the target Nyquist instead of aliasing it (%i Hz)", sampleRate => {
        const output = downsampleTo11025(sine(7000, sampleRate, 2.0), sampleRate)
        const aliased = Math.abs(TARGET_SR - 7000)
        expect(magnitudeAt(output, aliased, TARGET_SR)).toBeLessThan(0.01)
        expect(rms(output)).toBeLessThan(0.05)
    })

    it("rejects material below the target rate", () => {
        expect(() => downsampleTo11025(sine(1000, 8000, 1.0), 8000)).toThrow()
    })
})
