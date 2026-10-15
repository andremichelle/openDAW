import {describe, expect, it} from "vitest"
import {TunerDisplayState} from "./TunerDisplayState"

describe("tuner visual release", () => {
    it("holds briefly, fades smoothly, and clears instead of showing a stale pitch forever", () => {
        const state = new TunerDisplayState()
        state.update(NaN, 0, 0.15)
        expect(state.opacity).toBe(0)
        state.update(69.03, 100, 0.15)
        state.update(NaN, 220, 0.15)
        expect(state.opacity).toBe(1)
        state.update(NaN, 720, 0.15)
        expect(state.opacity).toBeCloseTo(0.5)
        expect(state.midi).toBe(69.03)
        state.update(NaN, 1020, 0.15)
        expect(state.opacity).toBeGreaterThan(0)
        state.update(NaN, 1220, 0.15)
        expect(state.opacity).toBe(0)
        expect(Number.isNaN(state.midi)).toBe(true)
    })
    it("reacquires a new note immediately during release and clears on bypass", () => {
        const state = new TunerDisplayState()
        state.update(69, 0, 1)
        state.update(NaN, 200, 1)
        state.update(69.4, 250, 1)
        expect(state.midi).toBe(69.4)
        expect(state.opacity).toBe(1)
        state.reset()
        expect(state.opacity).toBe(0)
        expect(Number.isNaN(state.midi)).toBe(true)
    })
})
