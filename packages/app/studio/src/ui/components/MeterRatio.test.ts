import {describe, expect, it} from "vitest"
import {ValueMapping} from "@opendaw/lib-std"
import {meterRatio} from "./MeterRatio"

// live id 1116: a NaN meter value reached an SVGLength and threw "The provided float value is non-finite"

describe("meterRatio", () => {
    const mapping = ValueMapping.linear(-24, 3)
    it("maps finite readings through the mapping", () => {
        expect(meterRatio(mapping, -24)).toBe(0.0)
        expect(meterRatio(mapping, 3)).toBe(1.0)
        expect(meterRatio(mapping, -10.5)).toBeCloseTo(0.5)
    })
    it("draws nothing for non-finite readings", () => {
        expect(meterRatio(mapping, Number.NaN)).toBe(0.0)
        expect(meterRatio(mapping, Number.NEGATIVE_INFINITY)).toBe(0.0)
        expect(meterRatio(mapping, Number.POSITIVE_INFINITY)).toBe(0.0)
    })
})
