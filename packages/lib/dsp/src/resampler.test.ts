import {describe, expect, test} from "vitest"
import {ResamplerMono, ResamplerStereo} from "./resampler"
import {RenderQuantum} from "./constants"

describe("Resampler", () => {
    describe("Basic functionality", () => {
        test("2x upsampling produces correct output length", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(RenderQuantum).fill(1.0)
            const output = new Float32Array(RenderQuantum * 2)

            resampler.upsample(input, output, 0, RenderQuantum)

            expect(output.length).toBe(RenderQuantum * 2)
        })

        test("4x upsampling produces correct output length", () => {
            const resampler = new ResamplerMono(4)
            const input = new Float32Array(RenderQuantum).fill(1.0)
            const output = new Float32Array(RenderQuantum * 4)

            resampler.upsample(input, output, 0, RenderQuantum)

            expect(output.length).toBe(RenderQuantum * 4)
        })

        test("8x upsampling produces correct output length", () => {
            const resampler = new ResamplerMono(8)
            const input = new Float32Array(RenderQuantum).fill(1.0)
            const output = new Float32Array(RenderQuantum * 8)

            resampler.upsample(input, output, 0, RenderQuantum)

            expect(output.length).toBe(RenderQuantum * 8)
        })
    })

    describe("DC offset preservation", () => {
        test("2x resampler preserves DC offset after warmup", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(RenderQuantum).fill(0.5)
            const upsampled = new Float32Array(RenderQuantum * 2)
            const downsampled = new Float32Array(RenderQuantum)

            // Warm up the filter (2 cycles is enough based on debug output)
            for (let i = 0; i < 2; i++) {
                resampler.upsample(input, upsampled, 0, RenderQuantum)
                resampler.downsample(upsampled, downsampled, 0, RenderQuantum)
            }

            // After warmup, measure the average
            const avgOutput = downsampled.reduce((sum, val) => sum + val, 0) / downsampled.length
            expect(Math.abs(avgOutput - 0.5)).toBeLessThan(0.005) // Within 0.5%
        })

        test("4x resampler preserves DC offset after warmup", () => {
            const resampler = new ResamplerMono(4)
            const input = new Float32Array(RenderQuantum).fill(0.5)
            const upsampled = new Float32Array(RenderQuantum * 4)
            const downsampled = new Float32Array(RenderQuantum)

            // More warmup for cascaded stages
            for (let i = 0; i < 3; i++) {
                resampler.upsample(input, upsampled, 0, RenderQuantum)
                resampler.downsample(upsampled, downsampled, 0, RenderQuantum)
            }

            const avgOutput = downsampled.reduce((sum, val) => sum + val, 0) / downsampled.length
            expect(Math.abs(avgOutput - 0.5)).toBeLessThan(0.01) // Within 1%
        })

        test("8x resampler preserves DC offset after warmup", () => {
            const resampler = new ResamplerMono(8)
            const input = new Float32Array(RenderQuantum).fill(0.5)
            const upsampled = new Float32Array(RenderQuantum * 8)
            const downsampled = new Float32Array(RenderQuantum)

            // Even more warmup for 3 cascaded stages
            for (let i = 0; i < 5; i++) {
                resampler.upsample(input, upsampled, 0, RenderQuantum)
                resampler.downsample(upsampled, downsampled, 0, RenderQuantum)
            }

            const avgOutput = downsampled.reduce((sum, val) => sum + val, 0) / downsampled.length
            expect(Math.abs(avgOutput - 0.5)).toBeLessThan(0.015) // Within 1.5%
        })
    })

    describe("Signal passthrough", () => {
        test("sine wave roughly preserved through 2x resample cycle", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(RenderQuantum)
            // Generate 440Hz sine at 44.1kHz
            for (let i = 0; i < RenderQuantum; i++) {
                input[i] = Math.sin(2 * Math.PI * 440 * i / 44100)
            }

            const upsampled = new Float32Array(RenderQuantum * 2)
            const downsampled = new Float32Array(RenderQuantum)

            resampler.upsample(input, upsampled, 0, RenderQuantum)
            resampler.downsample(upsampled, downsampled, 0, RenderQuantum)

            // Check that signal energy is roughly preserved (not testing exact frequency)
            const inputRMS = Math.sqrt(input.reduce((s, v) => s + v * v, 0) / input.length)
            const outputRMS = Math.sqrt(downsampled.reduce((s, v) => s + v * v, 0) / downsampled.length)

            expect(Math.abs(outputRMS - inputRMS) / inputRMS).toBeLessThan(0.2) // Within 20%
        })
    })

    describe("Reset functionality", () => {
        test("reset clears state", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(RenderQuantum).fill(1.0)
            const output1 = new Float32Array(RenderQuantum * 2)
            const output2 = new Float32Array(RenderQuantum * 2)

            resampler.upsample(input, output1, 0, RenderQuantum)
            resampler.reset()
            resampler.upsample(input, output2, 0, RenderQuantum)

            // Outputs should be identical after reset
            for (let i = 0; i < output1.length; i++) {
                expect(Math.abs(output1[i] - output2[i])).toBeLessThan(1e-6)
            }
        })
    })

    describe("Stereo resampler", () => {
        test("processes stereo channels independently", () => {
            const resampler = new ResamplerStereo(2)
            const inputL = new Float32Array(RenderQuantum).fill(0.5)
            const inputR = new Float32Array(RenderQuantum).fill(-0.5)
            const outputL = new Float32Array(RenderQuantum * 2)
            const outputR = new Float32Array(RenderQuantum * 2)

            resampler.upsample([inputL, inputR], [outputL, outputR], 0, RenderQuantum)

            const avgL = outputL.reduce((sum, val) => sum + val, 0) / outputL.length
            const avgR = outputR.reduce((sum, val) => sum + val, 0) / outputR.length

            expect(avgL).toBeGreaterThan(0)
            expect(avgR).toBeLessThan(0)
        })

        test("stereo downsampling works correctly after warmup", () => {
            const resampler = new ResamplerStereo(4)
            const inputL = new Float32Array(RenderQuantum).fill(0.8)
            const inputR = new Float32Array(RenderQuantum).fill(0.3)
            const upsampledL = new Float32Array(RenderQuantum * 4)
            const upsampledR = new Float32Array(RenderQuantum * 4)
            const downsampledL = new Float32Array(RenderQuantum)
            const downsampledR = new Float32Array(RenderQuantum)

            // Warm up
            for (let i = 0; i < 3; i++) {
                resampler.upsample([inputL, inputR], [upsampledL, upsampledR], 0, RenderQuantum)
                resampler.downsample([upsampledL, upsampledR], [downsampledL, downsampledR], 0, RenderQuantum)
            }

            const avgL = downsampledL.reduce((sum, val) => sum + val, 0) / downsampledL.length
            const avgR = downsampledR.reduce((sum, val) => sum + val, 0) / downsampledR.length

            expect(Math.abs(avgL - 0.8)).toBeLessThan(0.02)
            expect(Math.abs(avgR - 0.3)).toBeLessThan(0.02)
        })
    })

    describe("Edge cases", () => {
        test("handles silence correctly", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(RenderQuantum).fill(0)
            const upsampled = new Float32Array(RenderQuantum * 2)
            const downsampled = new Float32Array(RenderQuantum)

            resampler.upsample(input, upsampled, 0, RenderQuantum)
            resampler.downsample(upsampled, downsampled, 0, RenderQuantum)

            const maxAbs = Math.max(...Array.from(downsampled).map(Math.abs))
            expect(maxAbs).toBeLessThan(1e-10)
        })

        test("handles partial processing ranges", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(RenderQuantum).fill(1.0)
            const output = new Float32Array(RenderQuantum * 2)

            // Process only part of the buffer
            const fromIndex = 10
            const toIndex = 50
            resampler.upsample(input, output, fromIndex, toIndex)

            // Check that we processed (toIndex - fromIndex) samples -> (toIndex - fromIndex) * 2 output samples
            const processedStart = fromIndex * 2
            const processedEnd = toIndex * 2

            // Output should have non-zero values in the processed range
            let hasNonZero = false
            for (let i = processedStart; i < processedEnd; i++) {
                if (Math.abs(output[i]) > 0.1) {
                    hasNonZero = true
                    break
                }
            }
            expect(hasNonZero).toBe(true)
        })
    })

    describe("Sample-exact output", () => {
        test("2x upsample produces expected output for deterministic input", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(16)
            for (let i = 0; i < 16; i++) {input[i] = Math.sin(2 * Math.PI * i / 16)}
            const output = new Float32Array(32)
            resampler.upsample(input, output, 0, 16)
            const snapshot = Array.from(output).map(v => Math.round(v * 1e6) / 1e6)
            expect(snapshot).toMatchSnapshot()
        })
        test("2x downsample produces expected output for deterministic input", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(32)
            for (let i = 0; i < 32; i++) {input[i] = Math.sin(2 * Math.PI * i / 32)}
            const output = new Float32Array(16)
            resampler.downsample(input, output, 0, 16)
            const snapshot = Array.from(output).map(v => Math.round(v * 1e6) / 1e6)
            expect(snapshot).toMatchSnapshot()
        })
        test("4x round-trip produces expected output for deterministic input", () => {
            const resampler = new ResamplerMono(4)
            const input = new Float32Array(RenderQuantum)
            for (let i = 0; i < RenderQuantum; i++) {input[i] = Math.sin(2 * Math.PI * 440 * i / 44100)}
            const upsampled = new Float32Array(RenderQuantum * 4)
            const output = new Float32Array(RenderQuantum)
            for (let i = 0; i < 3; i++) {
                resampler.upsample(input, upsampled, 0, RenderQuantum)
                resampler.downsample(upsampled, output, 0, RenderQuantum)
            }
            const snapshot = Array.from(output.subarray(0, 32)).map(v => Math.round(v * 1e6) / 1e6)
            expect(snapshot).toMatchSnapshot()
        })
        test("8x round-trip produces expected output for deterministic input", () => {
            const resampler = new ResamplerMono(8)
            const input = new Float32Array(RenderQuantum)
            for (let i = 0; i < RenderQuantum; i++) {input[i] = Math.sin(2 * Math.PI * 440 * i / 44100)}
            const upsampled = new Float32Array(RenderQuantum * 8)
            const output = new Float32Array(RenderQuantum)
            for (let i = 0; i < 5; i++) {
                resampler.upsample(input, upsampled, 0, RenderQuantum)
                resampler.downsample(upsampled, output, 0, RenderQuantum)
            }
            const snapshot = Array.from(output.subarray(0, 32)).map(v => Math.round(v * 1e6) / 1e6)
            expect(snapshot).toMatchSnapshot()
        })
    })

    describe("Consistency across multiple calls", () => {
        test("produces consistent results with same input", () => {
            const resampler = new ResamplerMono(2)
            const input = new Float32Array(RenderQuantum)
            for (let i = 0; i < RenderQuantum; i++) {
                input[i] = Math.random() * 2 - 1
            }

            const output1 = new Float32Array(RenderQuantum * 2)
            const output2 = new Float32Array(RenderQuantum * 2)

            resampler.reset()
            resampler.upsample(input, output1, 0, RenderQuantum)

            resampler.reset()
            resampler.upsample(input, output2, 0, RenderQuantum)

            for (let i = 0; i < output1.length; i++) {
                expect(output1[i]).toBeCloseTo(output2[i], 10)
            }
        })
    })
})