// #530: a section render steps in 48000-frame chunks while the settled delay compensation is trimmed from the
// start. With a latency that is not a whole number of quanta, each step ended mid-quantum and the rest of that
// quantum was discarded, so everything after frame 48000 came out early. The fake renderer writes a running frame
// counter, so a continuous output reads trim, trim + 1, trim + 2, ... across every step boundary.
import {describe, expect, it} from "vitest"
import {int} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {QuantumStepper} from "../src/quantum-stepper"

const createCounter = (latency: int) => {
    let frame = 0
    let trim = latency
    return (out: Float32Array[]): int => {
        for (let index = 0; index < RenderQuantum; index++) {
            out[0][index] = frame
            out[1][index] = -frame
            frame++
        }
        const start = Math.min(trim, RenderQuantum)
        trim -= start
        return start
    }
}

const renderInSteps = (latency: int, steps: ReadonlyArray<int>): Float32Array[] => {
    const stepper = new QuantumStepper(2)
    const render = createCounter(latency)
    const total = steps.reduce((sum, count) => sum + count, 0)
    const result = [new Float32Array(total), new Float32Array(total)]
    let offset = 0
    for (const count of steps) {
        const channels = stepper.step(count, render)
        expect(channels[0].length).toBe(count)
        result[0].set(channels[0], offset)
        result[1].set(channels[1], offset)
        offset += count
    }
    return result
}

const expectContinuous = (channels: Float32Array[], latency: int): void => {
    for (let index = 0; index < channels[0].length; index++) {
        if (channels[0][index] !== latency + index || channels[1][index] !== -(latency + index)) {
            throw new Error(`frame ${index} reads ${channels[0][index]}, expected ${latency + index}`)
        }
    }
}

describe("QuantumStepper (#530)", () => {
    for (const latency of [0, 15, 128, 221, 240, 1280]) {
        it(`stays continuous across 48000-frame steps with ${latency} frames of latency`, () => {
            expectContinuous(renderInSteps(latency, [48000, 48000, 48000, 48000]), latency)
        })
    }
    it("stays continuous across steps that are not quantum multiples", () => {
        expectContinuous(renderInSteps(240, [1, 127, 129, 1000, 3, 48000, 77]), 240)
        expectContinuous(renderInSteps(0, [1, 127, 129, 1000, 3, 48000, 77]), 0)
    })
    it("a step of zero frames renders nothing and keeps the stream continuous", () => {
        expectContinuous(renderInSteps(15, [100, 0, 100]), 15)
    })
    it("clear drops the leftover of the last quantum", () => {
        const stepper = new QuantumStepper(2)
        const render = createCounter(0)
        stepper.step(100, render)
        stepper.clear()
        expect(stepper.step(1, render)[0][0]).toBe(RenderQuantum)
    })
    it("renders no more quanta than needed", () => {
        const stepper = new QuantumStepper(2)
        let quanta = 0
        const render = createCounter(240)
        const counting = (out: Float32Array[]): int => {
            quanta++
            return render(out)
        }
        stepper.step(48000, counting)
        expect(quanta).toBe(Math.ceil((48000 + 240) / RenderQuantum))
    })
})
