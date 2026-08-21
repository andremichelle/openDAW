import {describe, expect, it} from "vitest"
import {
    clampClipCount,
    clampClipMoveDelta,
    MaxClipCount,
    movedClipCount
} from "@/ui/timeline/tracks/audio-unit/clips/constants.ts"

describe("clip view bounds (185)", () => {
    it("keeps every moved clip inside the last available column", () => {
        expect(clampClipMoveDelta(20, [0], MaxClipCount)).toBe(8)
        expect(clampClipMoveDelta(4, [1, 7], MaxClipCount)).toBe(1)
        expect(clampClipMoveDelta(-20, [2, 5], MaxClipCount)).toBe(-2)
    })

    it("grows the visible clip count to include a moved clip", () => {
        expect(movedClipCount(3, [0], 8)).toBe(9)
        expect(movedClipCount(3, [1, 2], 2)).toBe(5)
        expect(movedClipCount(3, [4], -2)).toBe(3)
    })

    it("caps resize while preserving every occupied column", () => {
        expect(clampClipCount(20, 1)).toBe(MaxClipCount)
        expect(clampClipCount(2, 5)).toBe(5)
        expect(clampClipCount(20, 12)).toBe(12)
    })
})
