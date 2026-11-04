import {describe, expect, it} from "vitest"
import {GrooveCurves, GrooveFunction, GroovePattern, QuantisedGrooveFunction} from "./grooves"
import {PPQN} from "./ppqn"

const samples = Array.from({length: 101}, (_, index) => index / 100)
const amounts = [0.0, 0.1, 0.25, 0.49, 0.5, 0.51, 0.75, 0.9, 1.0]

const expectMonotonic = (func: GrooveFunction) => {
    let previous = -Infinity
    for (const x of samples) {
        const y = func.fx(x)
        expect(y).toBeGreaterThanOrEqual(previous)
        previous = y
    }
}

const expectEndpoints = (func: GrooveFunction) => {
    expect(func.fx(0.0)).toBe(0.0)
    expect(func.fx(1.0)).toBe(1.0)
    expect(func.fy(0.0)).toBe(0.0)
    expect(func.fy(1.0)).toBe(1.0)
}

// fx(fy(y)) stays well conditioned where a curve flattens at 0% or 100% amount
const expectInverse = (func: GrooveFunction, digits: number) => {
    for (const y of samples) {expect(func.fx(func.fy(y))).toBeCloseTo(y, digits)}
}

describe("GrooveCurves", () => {
    it("power and s-curve are their own inverse pairs", () => {
        expectInverse(GrooveCurves.Power, 9)
        expectInverse(GrooveCurves.SCurve, 9)
    })
    it("power pushes later, s-curve pulls towards the middle", () => {
        expect(GrooveCurves.Power.fx(0.5)).toBeGreaterThan(0.5)
        expect(GrooveCurves.SCurve.fx(0.25)).toBeGreaterThan(0.25)
        expect(GrooveCurves.SCurve.fx(0.75)).toBeLessThan(0.75)
        expect(GrooveCurves.SCurve.fx(0.5)).toBe(0.5)
    })
    it("blend is straight at 50%, nearly the function at 100% and nearly the inverse at 0%", () => {
        for (const func of [GrooveCurves.Power, GrooveCurves.SCurve]) {
            for (const x of samples) {
                expect(GrooveCurves.blend(func, 0.5).fx(x)).toBeCloseTo(x, 12)
                expect(GrooveCurves.blend(func, 1.0).fx(x)).toBeCloseTo(x + 0.98 * (func.fx(x) - x), 12)
                expect(GrooveCurves.blend(func, 0.0).fx(x)).toBeCloseTo(x + 0.98 * (func.fy(x) - x), 12)
            }
        }
    })
    it("every blend is monotonic, keeps its endpoints and inverts", () => {
        for (const func of [GrooveCurves.Power, GrooveCurves.SCurve]) {
            for (const amount of amounts) {
                const blended = GrooveCurves.blend(func, amount)
                expectMonotonic(blended)
                expectEndpoints(blended)
                // the inverse s-curve has a vertical tangent at the middle, a jump of 6e-5 of a cell in double precision
                expectInverse(blended, 3)
            }
        }
    })
    it("random values rise from 0 to 1 and depend only on seed, steps and roughness", () => {
        for (const steps of [1, 2, 3, 8, 16, 64]) {
            for (const roughness of [0.0, 0.5, 1.0]) {
                const values = GrooveCurves.randomValues(7, steps, roughness)
                expect(values.length).toBe(steps + 1)
                expect(values[0]).toBe(0.0)
                expect(values[steps]).toBe(1.0)
                for (let index = 1; index <= steps; index++) {expect(values[index]).toBeGreaterThan(values[index - 1])}
            }
        }
        expect(GrooveCurves.randomValues(7, 8, 0.5)).toEqual(GrooveCurves.randomValues(7, 8, 0.5))
        expect(GrooveCurves.randomValues(7, 8, 0.5)).not.toEqual(GrooveCurves.randomValues(8, 8, 0.5))
    })
    it("roughness 0 is straight", () => {
        const values = GrooveCurves.randomValues(3, 4, 0.0)
        expect(Array.from(values)).toEqual([0.0, 0.25, 0.5, 0.75, 1.0])
    })
    it("random blends are monotonic and invert", () => {
        const random = new QuantisedGrooveFunction(GrooveCurves.randomValues(11, 8, 1.0))
        for (const amount of amounts) {
            const blended = GrooveCurves.blend(random, amount)
            expectMonotonic(blended)
            expectEndpoints(blended)
            expectInverse(blended, 6)
        }
    })
    it("a pattern with zero duration passes positions through", () => {
        const pattern = new GroovePattern({duration: () => 0, ...GrooveCurves.Power})
        expect(pattern.warp(123.0)).toBe(123.0)
        expect(pattern.unwarp(123.0)).toBe(123.0)
    })
    it("a blended pattern warps within its cells and round trips", () => {
        const pattern = new GroovePattern({duration: () => PPQN.SemiQuaver * 2, ...GrooveCurves.blend(GrooveCurves.SCurve, 0.8)})
        for (let position = 0; position < PPQN.Bar * 2; position += 37) {
            expect(pattern.unwarp(pattern.warp(position))).toBeCloseTo(position, 4)
            expect(Math.floor(pattern.warp(position) / (PPQN.SemiQuaver * 2))).toBe(Math.floor(position / (PPQN.SemiQuaver * 2)))
        }
    })
})
