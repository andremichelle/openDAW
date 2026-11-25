import {describe, expect, it} from "vitest"
import {TunerLayout} from "./TunerCanvasLayout"
import {TunerHistoryAxis} from "./TunerHistoryAxis"

describe("tuner history key axis", () => {
    it("centers the target key and places higher notes above it", () => {
        const {historyCenter, historyHeight} = TunerLayout
        const step = historyHeight / 4
        const keys = TunerHistoryAxis.keys(62, 4)
        expect(keys.find(key => key.note === 62)).toEqual({note: 62, y: historyCenter, top: historyCenter - step / 2, height: step})
        expect(keys.find(key => key.note === 63)?.y).toBe(historyCenter - step)
        expect(keys.find(key => key.note === 61)?.y).toBe(historyCenter + step)
    })
    it("keeps whole bands that overlap the plot so rows slide in and out", () => {
        for (const center of [62, 62.3, 62.5, 62.8]) {
            for (const span of [2, 3, 6, 24]) {
                const step = TunerLayout.historyHeight / span
                const keys = TunerHistoryAxis.keys(center, span).sort((a, b) => a.top - b.top)
                expect(keys[0].top).toBeLessThanOrEqual(TunerLayout.historyTop)
                expect(keys[keys.length - 1].top + step).toBeGreaterThanOrEqual(TunerLayout.historyBottom)
                keys.forEach((key, index) => {
                    expect(key.height).toBeCloseTo(step)
                    if (index > 0) {expect(key.top).toBeCloseTo(keys[index - 1].top + step)}
                })
            }
        }
    })
    it("labels every key while rows are tall enough, then white keys, then only C", () => {
        expect([60, 61, 62].map(note => TunerHistoryAxis.labeled(note, 1.5))).toEqual([true, true, true])
        expect([60, 61, 62].map(note => TunerHistoryAxis.labeled(note, 0.8))).toEqual([true, false, true])
        expect([60, 61, 62, 72].map(note => TunerHistoryAxis.labeled(note, 0.4))).toEqual([true, false, false, true])
    })
})
