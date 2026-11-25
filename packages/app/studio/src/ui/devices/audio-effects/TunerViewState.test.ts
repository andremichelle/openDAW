import {describe, expect, it} from "vitest"
import {TunerViewState} from "./TunerViewState"

const range = {center: 69, span: 6}
const signal = new Float32Array([440, 1, -20])

describe("tuner view state", () => {
    it("stops animation when the idle meter or histogram has nothing to show", () => {
        const state = new TunerViewState(69, 6)
        state.update(0, true, 440, true, range)
        expect(state.animating(false)).toBe(false)
        expect(state.animating(true)).toBe(false)
        state.receive(signal, 0)
        state.update(0, true, 440, true, range)
        expect(state.animating(false)).toBe(true)
        state.update(301, true, 440, true, range)
        state.update(1600, true, 440, true, range)
        expect(state.animating(false)).toBe(false)
        expect(state.animating(true)).toBe(true)
        state.update(8400, true, 440, true, range)
        expect(state.animating(true)).toBe(false)
    })
    it("keeps signal-loss gaps and never adds faded pitches to live history", () => {
        const state = new TunerViewState(69, 6)
        state.receive(signal, 0)
        state.update(0, true, 440, true, range)
        state.receive(new Float32Array([0, 0, -120]), 40)
        state.update(40, true, 440, true, range)
        state.update(500, true, 440, true, range)
        expect(state.visible).toBe(true)
        expect(state.display.opacity).toBeLessThan(1)
        expect(state.history).toEqual([{time: 0, midi: 69}, {time: 40, midi: NaN}])
        state.receive(signal, 600)
        state.update(600, true, 440, true, range)
        expect(state.history[2]).toEqual({time: 600, midi: 69})
        state.update(601, false, 440, true, range)
        expect(state.visible).toBe(false)
    })
    it("uses live preview without changing the saved range or auto-follow flag", () => {
        const state = new TunerViewState(69, 6)
        state.preview = {center: 57, span: 12}
        state.receive(signal, 0)
        state.update(0, true, 440, true, range)
        expect([state.center, state.span]).toEqual([57, 12])
        expect(range).toEqual({center: 69, span: 6})
        state.preview = undefined
        state.update(40, true, 440, false, range)
        expect([state.center, state.span]).toEqual([69, 6])
    })
})
