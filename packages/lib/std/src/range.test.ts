import {describe, expect, it} from "vitest"
import {Range} from "./range"

describe("Range", () => {
    it("keeps x <-> value mapping finite when the width collapses to the padding", () => {
        const range = new Range({padding: 12})
        range.width = 12
        const position = range.xToValue(50)
        expect(Number.isFinite(position)).true
        range.scaleBy(-0.04, position)
        expect(Number.isFinite(range.min)).true
        expect(Number.isFinite(range.max)).true
    })

    it("set() never collapses the range to zero width, so scaleBy stays finite (regression #1037)", () => {
        // Root cause: set() let min === max; scaleBy then divided by range === 0 -> non-finite min/max ->
        // the SVG slider threw "SVGLength non-finite". set() must uphold the minimum-width invariant.
        const range = new Range({minimum: 0.01})
        range.set(0.5, 0.5)
        expect(range.max).toBeGreaterThan(range.min)
        expect(range.max - range.min).toBeGreaterThanOrEqual(0.01)
        range.scaleBy(-0.5, 0.5)
        expect(Number.isFinite(range.min)).true
        expect(Number.isFinite(range.max)).true
    })

    it("set() enforces the minimum width even near the right edge (regression #1037)", () => {
        const range = new Range({minimum: 0.01})
        range.set(1.0, 1.0)
        expect(range.max).toBe(1.0)
        expect(range.max - range.min).toBeGreaterThanOrEqual(0.01)
    })

    it("set() ignores a non-finite input (regression #1037)", () => {
        const range = new Range()
        range.set(0.25, 0.75)
        range.set(Number.NaN, 0.5)
        expect(range.min).toBe(0.25)
        expect(range.max).toBe(0.75)
        range.set(0.1, Number.POSITIVE_INFINITY)
        expect(range.min).toBe(0.25)
        expect(range.max).toBe(0.75)
    })

    it("keeps x <-> value mapping finite when the width collapses to zero", () => {
        const range = new Range({padding: 12})
        range.width = 0
        const position = range.xToValue(12)
        expect(Number.isFinite(position)).true
        range.scaleBy(0.04, position)
        expect(Number.isFinite(range.min)).true
        expect(Number.isFinite(range.max)).true
    })

    it("recovers normal mapping after the width is restored", () => {
        const range = new Range({padding: 12})
        range.width = 12
        range.scaleBy(-0.04, range.xToValue(50))
        range.width = 1000
        range.set(0.25, 0.75)
        expect(range.xToValue(range.valueToX(0.5))).toBeCloseTo(0.5)
    })
})
