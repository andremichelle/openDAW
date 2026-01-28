import {describe, expect, test} from "vitest"
import {FrequencyDomainConvolver} from "./frequency-domain-convolver"
import {TimeDomainConvolver} from "./time-domain-convolver"

describe("FrequencyDomainConvolver", () => {
    describe("constructor", () => {
        test("creates convolver with specified parameters", () => {
            const convolver = new FrequencyDomainConvolver(2048, 128)
            expect(convolver.irLength).toBe(0)
            expect(convolver.latency).toBeGreaterThan(0)
        })
    })

    describe("setImpulseResponse", () => {
        test("sets IR and updates length", () => {
            const convolver = new FrequencyDomainConvolver(2048, 128)
            const ir = new Float32Array([1, 0.5, 0.25])
            convolver.setImpulseResponse(ir)
            expect(convolver.irLength).toBe(3)
        })
    })

    describe("process", () => {
        test("identity IR passes signal through with latency", () => {
            const blockSize = 128
            const convolver = new FrequencyDomainConvolver(256, blockSize)
            convolver.setImpulseResponse(new Float32Array([1]))

            const totalSamples = convolver.latency + blockSize * 2
            const input = new Float32Array(totalSamples)
            const output = new Float32Array(totalSamples)

            for (let i = 0; i < totalSamples; i++) {
                input[i] = Math.sin(2 * Math.PI * 4 * i / blockSize)
            }

            convolver.process(input, output, 0, totalSamples)

            let correlation = 0
            const offset = convolver.latency
            for (let i = 0; i < blockSize; i++) {
                correlation += input[i] * output[i + offset]
            }
            expect(correlation).toBeGreaterThan(0)
        })

        test("empty IR produces silence", () => {
            const convolver = new FrequencyDomainConvolver(256, 128)
            convolver.setImpulseResponse(new Float32Array(0))

            const input = new Float32Array(256).fill(1.0)
            const output = new Float32Array(256)

            convolver.process(input, output, 0, 256)

            for (let i = 0; i < output.length; i++) {
                expect(output[i]).toBe(0)
            }
        })

        test("gain IR scales amplitude after latency", () => {
            const blockSize = 64
            const convolver = new FrequencyDomainConvolver(128, blockSize)
            convolver.setImpulseResponse(new Float32Array([0.5]))

            const totalSamples = convolver.latency + blockSize * 3
            const input = new Float32Array(totalSamples).fill(1.0)
            const output = new Float32Array(totalSamples)

            convolver.process(input, output, 0, totalSamples)

            let sum = 0
            const startSample = convolver.latency + blockSize
            for (let i = startSample; i < startSample + blockSize; i++) {
                sum += output[i]
            }
            const average = sum / blockSize
            expect(average).toBeCloseTo(0.5, 1)
        })

        test("multiple buffers produce continuous output", () => {
            const blockSize = 64
            const convolver = new FrequencyDomainConvolver(128, blockSize)
            convolver.setImpulseResponse(new Float32Array([1]))

            const buffer1 = new Float32Array(blockSize)
            const buffer2 = new Float32Array(blockSize)
            const output1 = new Float32Array(blockSize)
            const output2 = new Float32Array(blockSize)

            for (let i = 0; i < blockSize; i++) {
                buffer1[i] = 1.0
                buffer2[i] = 1.0
            }

            convolver.process(buffer1, output1, 0, blockSize)
            convolver.process(buffer2, output2, 0, blockSize)

            expect(output1[blockSize - 1]).toBeCloseTo(output2[0], 1)
        })
    })

    describe("clear", () => {
        test("resets convolver state", () => {
            const blockSize = 64
            const convolver = new FrequencyDomainConvolver(128, blockSize)
            convolver.setImpulseResponse(new Float32Array([1]))

            const input = new Float32Array(blockSize).fill(1.0)
            const output1 = new Float32Array(blockSize)
            convolver.process(input, output1, 0, blockSize)

            convolver.clear()

            const output2 = new Float32Array(blockSize)
            convolver.process(new Float32Array(blockSize), output2, 0, blockSize)

            expect(output2[0]).toBeCloseTo(0, 5)
        })
    })

    describe("latency", () => {
        test("reports non-zero latency", () => {
            const convolver = new FrequencyDomainConvolver(2048, 128)
            expect(convolver.latency).toBeGreaterThan(0)
        })
    })

    describe("comparison with time-domain", () => {
        test("produces equivalent results to time-domain convolver", () => {
            const irLength = 64
            const blockSize = 128
            const numBlocks = 10

            const ir = new Float32Array(irLength)
            ir[0] = 1.0
            for (let i = 1; i < irLength; i++) {
                ir[i] = Math.exp(-i / 20) * 0.3 * (Math.random() * 2 - 1)
            }

            const timeDomain = new TimeDomainConvolver(irLength)
            const freqDomain = new FrequencyDomainConvolver(irLength, blockSize)

            timeDomain.setImpulseResponse(ir)
            freqDomain.setImpulseResponse(ir)

            const totalSamples = blockSize * numBlocks
            const input = new Float32Array(totalSamples)
            for (let i = 0; i < totalSamples; i++) {
                input[i] = Math.sin(2 * Math.PI * 440 * i / 48000)
            }

            const timeOutput = new Float32Array(totalSamples)
            const freqOutput = new Float32Array(totalSamples)

            timeDomain.process(input, timeOutput, 0, totalSamples)
            freqDomain.process(input, freqOutput, 0, totalSamples)

            const latency = freqDomain.latency
            let maxDiff = 0
            let sumSquaredDiff = 0
            let count = 0

            for (let i = latency + blockSize; i < totalSamples - blockSize; i++) {
                const diff = Math.abs(timeOutput[i - latency] - freqOutput[i])
                maxDiff = Math.max(maxDiff, diff)
                sumSquaredDiff += diff * diff
                count++
            }

            const rmsDiff = Math.sqrt(sumSquaredDiff / count)
            expect(rmsDiff).toBeLessThan(0.1)
        })
    })
})
