import {describe, expect, it} from "vitest"
import {TunerCanvasLayout} from "./TunerCanvasLayout"

describe("tuner display proportions", () => {
    it("centers zero on the meter and bounds markers to the scale", () => {
        const frame = TunerCanvasLayout.fit(480, 240)
        expect(TunerCanvasLayout.meterX(frame, -50)).toBeCloseTo(12)
        expect(TunerCanvasLayout.meterX(frame, 0)).toBe(240)
        expect(TunerCanvasLayout.meterX(frame, 50)).toBeCloseTo(468)
        expect(TunerCanvasLayout.meterX(frame, -100)).toBeCloseTo(12)
        expect(TunerCanvasLayout.meterX(frame, 100)).toBeCloseTo(468)
    })
    it("uses the full canvas width and centers the drawing vertically", () => {
        for (const [width, height] of [[376, 132], [328, 148], [480, 300], [656, 296], [960, 480]]) {
            const frame = TunerCanvasLayout.fit(width, height)
            expect(frame.scale).toBeGreaterThan(0)
            expect(frame.y).toBeGreaterThanOrEqual(0)
            expect(frame.right * frame.scale).toBeCloseTo(width)
            expect(240 * frame.scale + 2 * frame.y).toBeCloseTo(height)
            expect(frame.keyLeft + 58).toBeCloseTo(frame.right)
            expect(frame.historyRight).toBeLessThan(frame.keyLeft)
        }
    })
})
