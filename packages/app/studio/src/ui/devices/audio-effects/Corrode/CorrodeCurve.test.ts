import {describe, expect, it} from "vitest"
import {CorrodeDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CorrodeCurve} from "./CorrodeCurve"

describe("CorrodeCurve", () => {
    it("peaks at the centre frequency", () => {
        expect(CorrodeCurve.magnitudeDb(3000.0, 3000.0, 2.0)).toBeCloseTo(0.0, 9)
        expect(CorrodeCurve.curveY(0.0, 0.4)).toBeCloseTo(0.4, 9)
    })
    it("is -3 dB at the band edges given by the width in octaves", () => {
        const width = 2.0
        const q = CorrodeDeviceBoxAdapter.widthToQ(width)
        const center = 1000.0
        expect(CorrodeCurve.magnitudeDb(center * Math.pow(2.0, width / 2), center, q)).toBeCloseTo(-3.0103, 3)
        expect(CorrodeCurve.magnitudeDb(center / Math.pow(2.0, width / 2), center, q)).toBeCloseTo(-3.0103, 3)
    })
    it("gets wider with a larger width", () => {
        const narrow = CorrodeCurve.magnitudeDb(4000.0, 1000.0, CorrodeDeviceBoxAdapter.widthToQ(0.5))
        const wide = CorrodeCurve.magnitudeDb(4000.0, 1000.0, CorrodeDeviceBoxAdapter.widthToQ(5.0))
        expect(wide).toBeGreaterThan(narrow)
    })
    it("draws grid lines inside 50 Hz to 18 kHz only", () => {
        expect(CorrodeCurve.GridFrequencies.every(hz => hz > 50.0 && hz < 18000.0)).toBe(true)
    })
    it("falls by the dB range over the full height below the peak", () => {
        expect(CorrodeCurve.curveY(-CorrodeCurve.RangeDb, 0.0)).toBeCloseTo(1.0, 9)
        expect(CorrodeCurve.curveY(-CorrodeCurve.RangeDb / 2, 0.4)).toBeCloseTo(0.9, 9)
    })
})
