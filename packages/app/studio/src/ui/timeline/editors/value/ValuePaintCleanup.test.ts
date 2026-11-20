import {describe, expect, it} from "vitest"
import {Interpolation} from "@opendaw/lib-dsp"
import {ValuePaintCleanup} from "./ValuePaintCleanup"

const strokes = (...values: Array<number>) => values.map((value, index) => ({position: index * 10, value}))
const values = (result: ReadonlyArray<ValuePaintCleanup.Stroke>) => result.map(stroke => stroke.value)
const positions = (result: ReadonlyArray<ValuePaintCleanup.Stroke>) => result.map(stroke => stroke.position)

describe("ValuePaintCleanup.reduce (step strokes)", () => {
    const None = Interpolation.None
    it("keeps only value changes", () => {
        const result = ValuePaintCleanup.reduce(strokes(0, 0, 0, 1, 1, 0, 0), None, null, null)
        expect(positions(result)).toEqual([0, 30, 50])
        expect(values(result)).toEqual([0, 1, 0])
    })
    it("drops the first stroke when the step before already holds its value", () => {
        const result = ValuePaintCleanup.reduce(strokes(0.5, 0.5, 1), None, {value: 0.5, interpolation: None}, null)
        expect(positions(result)).toEqual([20])
    })
    it("keeps the first stroke after a linear event of the same value when a change follows", () => {
        const result = ValuePaintCleanup.reduce(strokes(0.5, 1), None, {value: 0.5, interpolation: Interpolation.Linear}, null)
        expect(positions(result)).toEqual([0, 10])
    })
    it("drops everything when nothing changes", () => {
        const result = ValuePaintCleanup.reduce(strokes(0.5, 0.5, 0.5), None,
            {value: 0.5, interpolation: None}, {value: 0.5, interpolation: None})
        expect(result).toEqual([])
    })
    it("keeps a single stroke without neighbours", () => {
        expect(values(ValuePaintCleanup.reduce(strokes(0.3), None, null, null))).toEqual([0.3])
    })
})

describe("ValuePaintCleanup.reduce (linear strokes)", () => {
    const Linear = Interpolation.Linear
    it("keeps both ends of a flat run before a ramp", () => {
        const result = ValuePaintCleanup.reduce(strokes(0, 0, 0, 1), Linear, null, null)
        expect(positions(result)).toEqual([0, 20, 30])
    })
    it("drops inner points of a flat run", () => {
        const result = ValuePaintCleanup.reduce(strokes(1, 0, 0, 0, 0, 1), Linear, null, null)
        expect(positions(result)).toEqual([0, 10, 40, 50])
    })
    it("drops a trailing flat run without a next event", () => {
        const result = ValuePaintCleanup.reduce(strokes(0, 1, 1, 1), Linear, null, null)
        expect(positions(result)).toEqual([0, 10])
    })
    it("keeps the end of a flat run when the event after differs", () => {
        const result = ValuePaintCleanup.reduce(strokes(0, 1, 1, 1), Linear, null, {value: 0, interpolation: Linear})
        expect(positions(result)).toEqual([0, 10, 30])
    })
    it("keeps different values untouched", () => {
        const result = ValuePaintCleanup.reduce(strokes(0, 0.25, 0.5, 0.75), Linear, null, null)
        expect(positions(result)).toEqual([0, 10, 20, 30])
    })
})
