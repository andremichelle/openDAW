import {describe, expect, it} from "vitest"
import {TunerHistoryAxis} from "./TunerHistoryAxis"

describe("tuner history key axis", () => {
    it("centers the target key and places higher notes above it", () => {
        const keys = TunerHistoryAxis.keys(62, 3)
        expect(keys.find(key => key.note === 62)).toEqual({note: 62, y: 90, top: 65, height: 50})
        expect(keys.find(key => key.note === 63)?.y).toBe(40)
        expect(keys.find(key => key.note === 61)?.y).toBe(140)
    })
    it("keeps whole bands that overlap the plot so rows slide in and out", () => {
        for (const center of [62, 62.3, 62.5, 62.8]) {
            for (const span of [2, 3, 6, 24]) {
                const step = 150 / span
                const keys = TunerHistoryAxis.keys(center, span).sort((a, b) => a.top - b.top)
                expect(keys[0].top).toBeLessThanOrEqual(15)
                expect(keys[keys.length - 1].top + step).toBeGreaterThanOrEqual(165)
                keys.forEach((key, index) => {
                    expect(key.height).toBeCloseTo(step)
                    if (index > 0) {expect(key.top).toBeCloseTo(keys[index - 1].top + step)}
                })
            }
        }
    })
})
