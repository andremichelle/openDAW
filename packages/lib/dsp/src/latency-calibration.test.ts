import {describe, expect, test} from "vitest"
import {generateMls} from "./latency-calibration"

describe("generateMls", () => {
    test("has length 2^order − 1 and values ±1", () => {
        const mls = generateMls(10)
        expect(mls.length).toBe(1023)
        for (const value of mls) {expect(Math.abs(value)).toBe(1)}
    })
    test("is balanced: one more +1 than −1", () => {
        const mls = generateMls(10)
        let sum = 0
        for (const value of mls) {sum += value}
        expect(sum).toBe(1)
    })
    test("circular autocorrelation is N at lag 0 and −1 elsewhere", () => {
        const order = 10
        const mls = generateMls(order)
        const length = mls.length
        const autocorrelation = (lag: number): number => {
            let sum = 0
            for (let index = 0; index < length; index++) {
                sum += mls[index] * mls[(index + lag) % length]
            }
            return sum
        }
        expect(autocorrelation(0)).toBe(length)
        for (const lag of [1, 2, 7, 100, 511, 1022]) {expect(autocorrelation(lag)).toBe(-1)}
    })
    test("is deterministic", () => {
        expect(Array.from(generateMls(12))).toEqual(Array.from(generateMls(12)))
    })
})
