import {describe, expect, it} from "vitest"
import {AudioMaterial, AudioMaterialSegment} from "./audio-material"

const segment = (position: number, overrides: Partial<AudioMaterialSegment> = {}): AudioMaterialSegment =>
    ({position, strength: 0.9, period: 0.0, harmonicity: 0.1, rms: 0.2, ...overrides})

const drumLoop = (): ReadonlyArray<AudioMaterialSegment> =>
    Array.from({length: 16}, (_, index) => segment(index * 0.25))

const pad = (): ReadonlyArray<AudioMaterialSegment> => [
    segment(0.0, {strength: 0.1, harmonicity: 0.85, period: 220.0}),
    segment(1.7, {strength: 0.15, harmonicity: 0.8, period: 218.0}),
    segment(5.1, {strength: 0.05, harmonicity: 0.9, period: 219.0})
]

describe("AudioMaterial.beatRegularity", () => {
    it("is 0 below three onsets, which span fewer than two intervals", () => {
        expect(AudioMaterial.beatRegularity([])).toBe(0.0)
        expect(AudioMaterial.beatRegularity([0.0])).toBe(0.0)
        expect(AudioMaterial.beatRegularity([0.0, 0.5])).toBe(0.0)
    })

    it("is 1 for a constant grid backed by enough intervals", () => {
        expect(AudioMaterial.beatRegularity([0.0, 0.5, 1.0, 1.5, 2.0])).toBe(1.0)
    })

    it("discounts a grid that only two intervals back", () => {
        expect(AudioMaterial.beatRegularity([0.0, 0.5, 1.0])).toBe(0.5)
    })

    it("drops as the intervals scatter", () => {
        const regular = AudioMaterial.beatRegularity([0.0, 0.5, 1.0, 1.5])
        const scattered = AudioMaterial.beatRegularity([0.0, 0.1, 1.4, 1.5])
        expect(scattered).toBeLessThan(regular)
        expect(scattered).toBeGreaterThan(0.0)
    })
})

describe("AudioMaterial.aggregate", () => {
    // The weights are DRAFT until they are fit on a labeled corpus, so these assert the separation the
    // features produce, not the exact probability the current constants happen to give.
    it("reads a dense, sharp, unpitched, regular loop as a drum loop", () => {
        const features = AudioMaterial.aggregate(drumLoop(), 4.0, 0.25, 1)
        expect(features.onsetCount).toBe(16)
        expect(features.onsetsPerSecond).toBe(4.0)
        expect(features.percussiveFraction).toBe(1.0)
        expect(features.pitchedFraction).toBe(0.0)
        expect(features.beatRegularity).toBe(1.0)
        expect(features.drumLoopProbability).toBeGreaterThan(0.75)
    })

    it("reads a sparse, soft, tonal swell as sustained material", () => {
        const features = AudioMaterial.aggregate(pad(), 8.0, 0.1, 1)
        expect(features.percussiveFraction).toBe(0.0)
        expect(features.pitchedFraction).toBe(1.0)
        expect(features.drumLoopProbability).toBeLessThan(0.25)
    })

    it("separates the two by a wide margin", () => {
        const loop = AudioMaterial.aggregate(drumLoop(), 4.0, 0.25, 1).drumLoopProbability
        const swell = AudioMaterial.aggregate(pad(), 8.0, 0.1, 1).drumLoopProbability
        expect(loop - swell).toBeGreaterThan(0.5)
    })

    it("drops near-silent segments from the averages but keeps them in the onset count", () => {
        const segments = [...drumLoop(), segment(4.0, {strength: 0.0, harmonicity: 1.0, rms: 0.0})]
        const features = AudioMaterial.aggregate(segments, 4.25, 0.25, 1)
        expect(features.onsetCount).toBe(17)
        expect(features.strengthMedian).toBeCloseTo(0.9)
        expect(features.percussiveFraction).toBe(1.0)
    })

    it("describes empty material without dividing by zero", () => {
        const features = AudioMaterial.aggregate([], 0.0, 0.0, 1)
        expect(features.onsetsPerSecond).toBe(0.0)
        expect(features.strengthMean).toBe(0.0)
        expect(features.pitchedFraction).toBe(0.0)
        expect(features.beatRegularity).toBe(0.0)
        expect(Number.isFinite(features.drumLoopProbability)).toBe(true)
    })

    it("carries the analyzer version through for cache invalidation", () => {
        expect(AudioMaterial.aggregate([], 0.0, 0.0, 7).analyzerVersion).toBe(7)
    })
})

describe("AudioMaterial.rmsOf", () => {
    it("averages the square over every channel", () => {
        const frames = [new Float32Array([1.0, -1.0]), new Float32Array([0.0, 0.0])]
        const rms = AudioMaterial.rmsOf({frames, numberOfFrames: 2, numberOfChannels: 2, sampleRate: 48000})
        expect(rms).toBeCloseTo(Math.sqrt(0.5))
    })

    it("is 0 for an empty buffer", () => {
        expect(AudioMaterial.rmsOf({frames: [], numberOfFrames: 0, numberOfChannels: 0, sampleRate: 48000})).toBe(0.0)
    })
})
