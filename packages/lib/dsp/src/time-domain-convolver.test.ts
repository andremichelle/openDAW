import {describe, expect, test} from "vitest"
import {TimeDomainConvolver} from "./time-domain-convolver"

describe("TimeDomainConvolver", () => {
    describe("constructor", () => {
        test("creates convolver with specified max IR length", () => {
            const convolver = new TimeDomainConvolver(2048)
            expect(convolver.irLength).toBe(0)
            expect(convolver.latency).toBe(0)
        })
    })

    describe("setImpulseResponse", () => {
        test("sets IR and updates length", () => {
            const convolver = new TimeDomainConvolver(2048)
            const ir = new Float32Array([1, 0.5, 0.25])
            convolver.setImpulseResponse(ir)
            expect(convolver.irLength).toBe(3)
        })

        test("truncates IR longer than max length", () => {
            const convolver = new TimeDomainConvolver(4)
            const ir = new Float32Array([1, 2, 3, 4, 5, 6])
            convolver.setImpulseResponse(ir)
            expect(convolver.irLength).toBe(4)
        })

        test("handles empty IR", () => {
            const convolver = new TimeDomainConvolver(2048)
            convolver.setImpulseResponse(new Float32Array(0))
            expect(convolver.irLength).toBe(0)
        })
    })

    describe("process", () => {
        test("identity IR passes signal through unchanged", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array([1]))

            const input = new Float32Array([0.5, -0.3, 0.8, 0.0, -1.0])
            const output = new Float32Array(5)

            convolver.process(input, output, 0, 5)

            for (let i = 0; i < input.length; i++) {
                expect(output[i]).toBeCloseTo(input[i], 5)
            }
        })

        test("delay IR delays signal by one sample", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array([0, 1]))

            const input = new Float32Array([1, 2, 3, 4, 5])
            const output = new Float32Array(5)

            convolver.process(input, output, 0, 5)

            expect(output[0]).toBeCloseTo(0, 5)
            expect(output[1]).toBeCloseTo(1, 5)
            expect(output[2]).toBeCloseTo(2, 5)
            expect(output[3]).toBeCloseTo(3, 5)
            expect(output[4]).toBeCloseTo(4, 5)
        })

        test("gain IR scales amplitude", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array([0.5]))

            const input = new Float32Array([1, 2, 3, 4])
            const output = new Float32Array(4)

            convolver.process(input, output, 0, 4)

            expect(output[0]).toBeCloseTo(0.5, 5)
            expect(output[1]).toBeCloseTo(1.0, 5)
            expect(output[2]).toBeCloseTo(1.5, 5)
            expect(output[3]).toBeCloseTo(2.0, 5)
        })

        test("impulse input produces IR as output", () => {
            const convolver = new TimeDomainConvolver(128)
            const ir = new Float32Array([0.8, 0.4, 0.2, 0.1])
            convolver.setImpulseResponse(ir)

            const input = new Float32Array(8)
            input[0] = 1.0
            const output = new Float32Array(8)

            convolver.process(input, output, 0, 8)

            expect(output[0]).toBeCloseTo(0.8, 5)
            expect(output[1]).toBeCloseTo(0.4, 5)
            expect(output[2]).toBeCloseTo(0.2, 5)
            expect(output[3]).toBeCloseTo(0.1, 5)
            expect(output[4]).toBeCloseTo(0.0, 5)
        })

        test("multiple buffers produce continuous output", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array([0, 1]))

            const input1 = new Float32Array([1, 2])
            const input2 = new Float32Array([3, 4])
            const output1 = new Float32Array(2)
            const output2 = new Float32Array(2)

            convolver.process(input1, output1, 0, 2)
            convolver.process(input2, output2, 0, 2)

            expect(output1[0]).toBeCloseTo(0, 5)
            expect(output1[1]).toBeCloseTo(1, 5)
            expect(output2[0]).toBeCloseTo(2, 5)
            expect(output2[1]).toBeCloseTo(3, 5)
        })

        test("empty IR produces silence", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array(0))

            const input = new Float32Array([1, 2, 3, 4])
            const output = new Float32Array(4)

            convolver.process(input, output, 0, 4)

            for (let i = 0; i < output.length; i++) {
                expect(output[i]).toBe(0)
            }
        })

        test("partial buffer processing works correctly", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array([1]))

            const input = new Float32Array([0, 0, 1, 2, 3, 0, 0])
            const output = new Float32Array(7)

            convolver.process(input, output, 2, 5)

            expect(output[0]).toBe(0)
            expect(output[1]).toBe(0)
            expect(output[2]).toBeCloseTo(1, 5)
            expect(output[3]).toBeCloseTo(2, 5)
            expect(output[4]).toBeCloseTo(3, 5)
            expect(output[5]).toBe(0)
            expect(output[6]).toBe(0)
        })

        test("convolution with multi-tap IR", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array([1, 1, 1]))

            const input = new Float32Array([1, 0, 0, 0, 0])
            const output = new Float32Array(5)

            convolver.process(input, output, 0, 5)

            expect(output[0]).toBeCloseTo(1, 5)
            expect(output[1]).toBeCloseTo(1, 5)
            expect(output[2]).toBeCloseTo(1, 5)
            expect(output[3]).toBeCloseTo(0, 5)
            expect(output[4]).toBeCloseTo(0, 5)
        })
    })

    describe("clear", () => {
        test("resets convolver state", () => {
            const convolver = new TimeDomainConvolver(128)
            convolver.setImpulseResponse(new Float32Array([0, 1]))

            const input1 = new Float32Array([1, 2])
            const output1 = new Float32Array(2)
            convolver.process(input1, output1, 0, 2)

            convolver.clear()

            const input2 = new Float32Array([3, 4])
            const output2 = new Float32Array(2)
            convolver.process(input2, output2, 0, 2)

            expect(output2[0]).toBeCloseTo(0, 5)
            expect(output2[1]).toBeCloseTo(3, 5)
        })
    })

    describe("latency", () => {
        test("reports zero latency", () => {
            const convolver = new TimeDomainConvolver(2048)
            expect(convolver.latency).toBe(0)
        })
    })

    describe("typical use case", () => {
        test("simulates cabinet IR processing", () => {
            const convolver = new TimeDomainConvolver(2048)

            const ir = new Float32Array(512)
            ir[0] = 1.0
            for (let i = 1; i < 512; i++) {
                ir[i] = Math.exp(-i / 100) * 0.5 * (Math.random() * 2 - 1)
            }
            convolver.setImpulseResponse(ir)

            const bufferSize = 128
            const numBuffers = 10
            const input = new Float32Array(bufferSize)
            const output = new Float32Array(bufferSize)

            let maxOutput = 0
            for (let buf = 0; buf < numBuffers; buf++) {
                for (let i = 0; i < bufferSize; i++) {
                    input[i] = Math.sin(2 * Math.PI * 440 * (buf * bufferSize + i) / 48000)
                }

                convolver.process(input, output, 0, bufferSize)

                for (let i = 0; i < bufferSize; i++) {
                    maxOutput = Math.max(maxOutput, Math.abs(output[i]))
                }
            }

            expect(maxOutput).toBeGreaterThan(0)
            expect(maxOutput).toBeLessThan(10)
        })
    })
})
