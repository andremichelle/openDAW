import {describe, expect, it} from "vitest"
import {ParameterValueEditing} from "./ParameterValueEditing"

describe("ParameterValueEditing.snapToSteps", () => {
    it("leaves values untouched for 0 and 1 steps", () => {
        for (const value of [0.0, 0.123, 0.5, 0.999, 1.0]) {
            expect(ParameterValueEditing.snapToSteps(value, 0)).toBe(value)
            expect(ParameterValueEditing.snapToSteps(value, 1)).toBe(value)
        }
    })
    it("snaps to off/on with 2 steps", () => {
        expect(ParameterValueEditing.snapToSteps(0.0, 2)).toBe(0.0)
        expect(ParameterValueEditing.snapToSteps(0.49, 2)).toBe(0.0)
        expect(ParameterValueEditing.snapToSteps(0.5, 2)).toBe(1.0)
        expect(ParameterValueEditing.snapToSteps(0.51, 2)).toBe(1.0)
        expect(ParameterValueEditing.snapToSteps(1.0, 2)).toBe(1.0)
    })
    it("snaps to N equal steps including both ends", () => {
        expect(ParameterValueEditing.snapToSteps(0.0, 3)).toBe(0.0)
        expect(ParameterValueEditing.snapToSteps(0.3, 3)).toBe(0.5)
        expect(ParameterValueEditing.snapToSteps(0.74, 3)).toBe(0.5)
        expect(ParameterValueEditing.snapToSteps(0.76, 3)).toBe(1.0)
        expect(ParameterValueEditing.snapToSteps(0.26, 5)).toBe(0.25)
        expect(ParameterValueEditing.snapToSteps(0.1, 11)).toBeCloseTo(0.1, 12)
    })
    it("produces exactly N distinct values", () => {
        for (const steps of [2, 3, 4, 10, 128]) {
            const values = new Set<number>()
            for (let index = 0; index <= 10000; index++) {values.add(ParameterValueEditing.snapToSteps(index / 10000, steps))}
            expect(values.size).toBe(steps)
        }
    })
})
