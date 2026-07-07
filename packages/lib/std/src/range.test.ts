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
