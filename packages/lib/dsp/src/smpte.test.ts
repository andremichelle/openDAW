import {describe, expect, it} from "vitest"
import {SMPTE} from "./smpte"

describe("SMPTE", () => {
    const FPS = 25

    describe("toSeconds", () => {
        it("should convert SMPTE to seconds at 25 fps", () => {
            expect(SMPTE.toSeconds(SMPTE.create(16), FPS)).toBe(16)
            expect(SMPTE.toSeconds(SMPTE.create(26), FPS)).toBe(26)
            expect(SMPTE.toSeconds(SMPTE.create(36, 12, 40), FPS)).toBe(36.5)
            expect(SMPTE.toSeconds(SMPTE.create(44, 18, 60), FPS)).toBe(44.75)
        })
    })

    describe("toShortString", () => {
        it("should format SMPTE as short string", () => {
            expect(SMPTE.toShortString(SMPTE.create(16))).toBe("16s")
            expect(SMPTE.toShortString(SMPTE.create(36, 12, 40))).toBe("36s 12fr 40sub")
        })
    })
})
