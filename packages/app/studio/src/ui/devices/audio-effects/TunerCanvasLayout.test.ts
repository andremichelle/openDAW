import {describe, expect, it} from "vitest"
import {fitTunerCanvas, tunerMeterX} from "./TunerCanvasLayout"

describe("tuner display proportions", () => {
    it("uses the inset display width with a centered zero and bounded markers", () => {
        expect(tunerMeterX(-50)).toBeCloseTo(18)
        expect(tunerMeterX(0)).toBe(240)
        expect(tunerMeterX(50)).toBeCloseTo(462)
        expect(tunerMeterX(-100)).toBeCloseTo(18)
        expect(tunerMeterX(100)).toBeCloseTo(462)
    })
    it("fits wide, tall and high-DPI panels without distorting the target circles", () => {
        for (const [width, height] of [[328, 148], [480, 300], [656, 296], [960, 480]]) {
            const {scale, x, y} = fitTunerCanvas(width, height)
            expect(scale).toBeGreaterThan(0)
            expect(x).toBeGreaterThanOrEqual(0)
            expect(y).toBeGreaterThanOrEqual(0)
            expect(480 * scale + 2 * x).toBeCloseTo(width)
            expect(240 * scale + 2 * y).toBeCloseTo(height)
            expect((480 * scale) / (240 * scale)).toBe(2)
        }
    })
})
