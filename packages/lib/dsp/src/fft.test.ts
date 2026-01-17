import {describe, expect, test} from "vitest"
import {FFT} from "./fft"

describe("FFT", () => {
    describe("forward and inverse", () => {
        test("inverse recovers original signal", () => {
            const n = 256
            const fft = new FFT(n)

            const real = new Float32Array(n)
            const imag = new Float32Array(n)
            const originalReal = new Float32Array(n)

            for (let i = 0; i < n; i++) {
                real[i] = Math.sin(2 * Math.PI * 4 * i / n) + 0.5 * Math.cos(2 * Math.PI * 8 * i / n)
                originalReal[i] = real[i]
                imag[i] = 0
            }

            fft.process(real, imag)
            fft.inverse(real, imag)

            for (let i = 0; i < n; i++) {
                expect(real[i]).toBeCloseTo(originalReal[i], 4)
            }
        })

        test("impulse transforms to constant spectrum", () => {
            const n = 64
            const fft = new FFT(n)

            const real = new Float32Array(n)
            const imag = new Float32Array(n)
            real[0] = 1.0

            fft.process(real, imag)

            for (let i = 0; i < n; i++) {
                expect(real[i]).toBeCloseTo(1.0, 5)
                expect(imag[i]).toBeCloseTo(0.0, 5)
            }
        })

        test("DC signal transforms to single bin", () => {
            const n = 64
            const fft = new FFT(n)

            const real = new Float32Array(n).fill(1.0)
            const imag = new Float32Array(n)

            fft.process(real, imag)

            expect(real[0]).toBeCloseTo(n, 5)
            for (let i = 1; i < n; i++) {
                expect(real[i]).toBeCloseTo(0, 5)
                expect(imag[i]).toBeCloseTo(0, 5)
            }
        })

        test("pure sine appears at correct bin", () => {
            const n = 128
            const fft = new FFT(n)

            const real = new Float32Array(n)
            const imag = new Float32Array(n)
            const frequency = 4

            for (let i = 0; i < n; i++) {
                real[i] = Math.sin(2 * Math.PI * frequency * i / n)
            }

            fft.process(real, imag)

            const magnitudes = new Float32Array(n)
            for (let i = 0; i < n; i++) {
                magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i])
            }

            let maxBin = 0
            let maxMag = 0
            for (let i = 0; i < n / 2; i++) {
                if (magnitudes[i] > maxMag) {
                    maxMag = magnitudes[i]
                    maxBin = i
                }
            }

            expect(maxBin).toBe(frequency)
        })

        test("energy is preserved (Parseval theorem)", () => {
            const n = 256
            const fft = new FFT(n)

            const real = new Float32Array(n)
            const imag = new Float32Array(n)

            for (let i = 0; i < n; i++) {
                real[i] = Math.random() * 2 - 1
            }

            let timeEnergy = 0
            for (let i = 0; i < n; i++) {
                timeEnergy += real[i] * real[i]
            }

            fft.process(real, imag)

            let freqEnergy = 0
            for (let i = 0; i < n; i++) {
                freqEnergy += real[i] * real[i] + imag[i] * imag[i]
            }
            freqEnergy /= n

            expect(freqEnergy).toBeCloseTo(timeEnergy, 3)
        })

        test("multiple forward-inverse cycles preserve signal", () => {
            const n = 128
            const fft = new FFT(n)

            const real = new Float32Array(n)
            const imag = new Float32Array(n)
            const originalReal = new Float32Array(n)

            for (let i = 0; i < n; i++) {
                real[i] = Math.random() * 2 - 1
                originalReal[i] = real[i]
            }

            for (let cycle = 0; cycle < 3; cycle++) {
                fft.process(real, imag)
                fft.inverse(real, imag)
            }

            for (let i = 0; i < n; i++) {
                expect(real[i]).toBeCloseTo(originalReal[i], 3)
            }
        })
    })

    describe("inverse", () => {
        test("constant spectrum inverse to impulse", () => {
            const n = 64
            const fft = new FFT(n)

            const real = new Float32Array(n).fill(1.0)
            const imag = new Float32Array(n).fill(0.0)

            fft.inverse(real, imag)

            expect(real[0]).toBeCloseTo(1.0, 5)
            for (let i = 1; i < n; i++) {
                expect(real[i]).toBeCloseTo(0.0, 5)
            }
        })
    })
})
