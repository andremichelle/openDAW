import {describe, expect, it} from "vitest"
import {clipScrollPosition} from "./ClipScroll"
import {ClipWidth} from "./constants"

describe("clip view scrolling", () => {
    it("preserves pixel offsets instead of snapping to columns", () => {
        expect(clipScrollPosition(12.5, 8, ClipWidth * 3 - 1)).toBe(12.5)
    })
    it("bounds scrolling to the content and resets when all columns fit", () => {
        expect(clipScrollPosition(-10, 8, ClipWidth * 3 - 1)).toBe(0)
        expect(clipScrollPosition(10000, 8, ClipWidth * 3 - 1)).toBe(ClipWidth * 5)
        expect(clipScrollPosition(100, 3, ClipWidth * 8)).toBe(0)
    })
})
