import {describe, expect, it} from "vitest"
import {TunerHistoryAxis} from "./TunerHistoryAxis"

describe("tuner history key axis", () => {
    it("centers the target key and places higher notes above it", () => {
        const keys = TunerHistoryAxis.keys(62, 3)
        expect(keys.find(key => key.note === 62)).toEqual({note: 62, y: 90, top: 65, height: 50})
        expect(keys.find(key => key.note === 63)?.y).toBe(40)
        expect(keys.find(key => key.note === 61)?.y).toBe(140)
    })
    it("draws only whole key bands while the range pans and zooms", () => {
        for (const center of [62, 62.3, 62.5, 62.8]) {
            for (const span of [2, 3, 6, 24]) {
                const step = 150 / span
                for (const key of TunerHistoryAxis.keys(center, span)) {
                    expect(key.height).toBeCloseTo(step)
                    expect(key.top).toBeGreaterThanOrEqual(15 - 1e-6)
                    expect(key.top + key.height).toBeLessThanOrEqual(165 + 1e-6)
                }
            }
        }
    })
})
