import {describe, expect, it} from "vitest"
import {tunerHistoryKeys} from "./TunerHistoryAxis"

describe("tuner history key axis", () => {
    it("centers the target key and places higher notes above it", () => {
        const keys = tunerHistoryKeys(62, 3)
        expect(keys.find(key => key.note === 62)).toEqual({note: 62, y: 105, top: 75, height: 60})
        expect(keys.find(key => key.note === 63)?.y).toBe(45)
        expect(keys.find(key => key.note === 61)?.y).toBe(165)
    })
    it("covers the plot without gaps or out-of-bounds bands during pan and zoom", () => {
        for (const span of [2, 3, 6, 24]) {
            const keys = tunerHistoryKeys(62.3, span).sort((a, b) => a.top - b.top)
            expect(keys[0].top).toBe(15)
            let bottom = 15
            for (const key of keys) {
                expect(key.top).toBeCloseTo(bottom)
                expect(key.height).toBeGreaterThan(0)
                bottom = key.top + key.height
            }
            expect(bottom).toBeCloseTo(195)
        }
    })
})
