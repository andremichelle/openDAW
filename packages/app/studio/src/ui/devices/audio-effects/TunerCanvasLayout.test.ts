import {describe, expect, it} from "vitest"
import {TunerCanvasLayout} from "./TunerCanvasLayout"

describe("tuner display proportions", () => {
    it("centers zero on the meter and bounds markers to the scale", () => {
        const frame = TunerCanvasLayout.fit(480, 210)
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
            expect(210 * frame.scale + 2 * frame.y).toBeCloseTo(height)
            expect(frame.keyLeft + 44).toBeCloseTo(frame.right)
            expect(frame.historyRight).toBeLessThan(frame.keyLeft)
        }
    })
    it("sizes text in css pixels on any display density", () => {
        for (const ratio of [1, 2, 3]) {
            const frame = TunerCanvasLayout.fit(328 * ratio, 132 * ratio, ratio)
            expect(frame.labelFont * frame.scale / ratio).toBeCloseTo(9)
            expect(frame.keyFont * frame.scale / ratio).toBeCloseTo(10)
            expect(frame.readoutFont * frame.scale / ratio).toBeCloseTo(12)
        }
    })
    it("limits the visible range so a key row stays at least 14 css px tall", () => {
        for (const ratio of [1, 2]) {
            const frame = TunerCanvasLayout.fit(328 * ratio, 132 * ratio, ratio)
            const rowPixels = 180 / frame.maxSpan * frame.scale / ratio
            expect(rowPixels).toBeCloseTo(14)
        }
    })
})
