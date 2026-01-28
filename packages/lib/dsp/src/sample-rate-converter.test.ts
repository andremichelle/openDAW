import {describe, expect, test} from "vitest"
import {SampleRateConverter} from "./sample-rate-converter"

describe("SampleRateConverter", () => {
    describe("convert", () => {
        test("same sample rate returns identical copy", () => {
            const source = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5])
            const result = SampleRateConverter.convert(source, 48000, 48000)

            expect(result.length).toBe(source.length)
            for (let i = 0; i < source.length; i++) {
                expect(result[i]).toBeCloseTo(source[i], 10)
            }
            expect(result).not.toBe(source)
        })

        test("empty source returns empty array", () => {
            const source = new Float32Array(0)
            const result = SampleRateConverter.convert(source, 48000, 44100)

            expect(result.length).toBe(0)
        })

        test("downsampling 96k to 48k halves length", () => {
            const source = new Float32Array(1000)
            const result = SampleRateConverter.convert(source, 96000, 48000)

            expect(result.length).toBe(500)
        })

        test("upsampling 44.1k to 48k increases length correctly", () => {
            const sourceLength = 441
            const source = new Float32Array(sourceLength)
            const result = SampleRateConverter.convert(source, 44100, 48000)

            const expectedLength = Math.floor(sourceLength / (44100 / 48000))
            expect(result.length).toBe(expectedLength)
        })

        test("downsampling 48k to 44.1k decreases length correctly", () => {
            const sourceLength = 480
            const source = new Float32Array(sourceLength)
            const result = SampleRateConverter.convert(source, 48000, 44100)

            const expectedLength = Math.floor(sourceLength / (48000 / 44100))
            expect(result.length).toBe(expectedLength)
        })

        test("DC signal is preserved", () => {
            const dcValue = 0.75
            const source = new Float32Array(1000).fill(dcValue)
            const result = SampleRateConverter.convert(source, 44100, 48000)

            const avgOutput = result.reduce((sum, value) => sum + value, 0) / result.length
            expect(avgOutput).toBeCloseTo(dcValue, 5)
        })

        test("linear ramp is preserved", () => {
            const source = new Float32Array(100)
            for (let i = 0; i < source.length; i++) {
                source[i] = i / (source.length - 1) // 0 to 1
            }

            const result = SampleRateConverter.convert(source, 48000, 44100)

            expect(result[0]).toBeCloseTo(0, 1)
            expect(result[result.length - 1]).toBeCloseTo(1, 1)
            for (let i = 1; i < result.length; i++) {
                expect(result[i]).toBeGreaterThanOrEqual(result[i - 1] - 0.001)
            }
        })

        test("sine wave frequency is approximately preserved", () => {
            const sourceSampleRate = 44100
            const targetSampleRate = 48000
            const frequency = 440 // Hz
            const duration = 0.1 // seconds
            const sourceLength = Math.floor(sourceSampleRate * duration)

            const source = new Float32Array(sourceLength)
            for (let i = 0; i < sourceLength; i++) {
                source[i] = Math.sin(2 * Math.PI * frequency * i / sourceSampleRate)
            }

            const result = SampleRateConverter.convert(source, sourceSampleRate, targetSampleRate)

            let zeroCrossings = 0
            for (let i = 1; i < result.length; i++) {
                if ((result[i - 1] < 0 && result[i] >= 0) || (result[i - 1] >= 0 && result[i] < 0)) {
                    zeroCrossings++
                }
            }

            const expectedCrossings = 2 * frequency * duration
            expect(zeroCrossings).toBeGreaterThan(expectedCrossings * 0.9)
            expect(zeroCrossings).toBeLessThan(expectedCrossings * 1.1)
        })

        test("energy is approximately preserved", () => {
            const source = new Float32Array(1000)
            for (let i = 0; i < source.length; i++) {
                source[i] = Math.sin(2 * Math.PI * 10 * i / source.length)
            }

            const result = SampleRateConverter.convert(source, 44100, 48000)

            const sourceRMS = Math.sqrt(source.reduce((sum, value) => sum + value * value, 0) / source.length)
            const resultRMS = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0) / result.length)

            expect(Math.abs(resultRMS - sourceRMS) / sourceRMS).toBeLessThan(0.05)
        })

        test("handles single sample input", () => {
            const source = new Float32Array([0.5])
            const result = SampleRateConverter.convert(source, 48000, 44100)

            expect(result.length).toBeGreaterThanOrEqual(1)
            expect(result[0]).toBeCloseTo(0.5, 5)
        })

        test("handles extreme downsampling ratio", () => {
            const source = new Float32Array(96000) // 1 second at 96kHz
            source.fill(0.5)
            const result = SampleRateConverter.convert(source, 96000, 8000)

            // 96000 / 12 = 8000
            expect(result.length).toBe(8000)
            expect(result[0]).toBeCloseTo(0.5, 5)
        })

        test("handles extreme upsampling ratio", () => {
            const source = new Float32Array(1000)
            source.fill(0.5)
            const result = SampleRateConverter.convert(source, 8000, 96000)

            // 1000 * 12 = 12000
            expect(result.length).toBe(12000)
            expect(result[0]).toBeCloseTo(0.5, 5)
        })
    })

    describe("calculateOutputLength", () => {
        test("same sample rate returns same length", () => {
            expect(SampleRateConverter.calculateOutputLength(1000, 48000, 48000)).toBe(1000)
        })

        test("downsampling 96k to 48k halves length", () => {
            expect(SampleRateConverter.calculateOutputLength(1000, 96000, 48000)).toBe(500)
        })

        test("upsampling 44.1k to 48k increases length", () => {
            const result = SampleRateConverter.calculateOutputLength(441, 44100, 48000)
            expect(result).toBe(480)
        })

        test("empty source returns zero", () => {
            expect(SampleRateConverter.calculateOutputLength(0, 48000, 44100)).toBe(0)
        })

        test("matches actual convert output length", () => {
            const source = new Float32Array(1234)
            const result = SampleRateConverter.convert(source, 44100, 48000)
            const calculated = SampleRateConverter.calculateOutputLength(1234, 44100, 48000)

            expect(result.length).toBe(calculated)
        })
    })
})
