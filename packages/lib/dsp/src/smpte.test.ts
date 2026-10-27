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

    describe("fromSeconds", () => {
        it("should split seconds into frames and subframes", () => {
            expect(SMPTE.fromSeconds(36.5, FPS)).toStrictEqual(SMPTE.create(36, 12, 40))
            expect(SMPTE.fromSeconds(3725.2, FPS)).toStrictEqual({hours: 1, minutes: 2, seconds: 5, frames: 5, subframes: 0})
        })
        it("should carry rounded subframes into the next frame", () => {
            expect(SMPTE.fromSeconds(0.0399, FPS)).toStrictEqual(SMPTE.create(0, 1, 0))
            expect(SMPTE.fromSeconds(7.0399, FPS)).toStrictEqual(SMPTE.create(7, 1, 0))
        })
        it("should carry a full frame into the next second, minute and hour", () => {
            expect(SMPTE.fromSeconds(0.99999, FPS)).toStrictEqual(SMPTE.create(1))
            expect(SMPTE.fromSeconds(59.99999, FPS)).toStrictEqual({hours: 0, minutes: 1, seconds: 0, frames: 0, subframes: 0})
            expect(SMPTE.fromSeconds(3599.99999, FPS)).toStrictEqual({hours: 1, minutes: 0, seconds: 0, frames: 0, subframes: 0})
        })
        it("should never produce subframes beyond the frame", () => {
            for (let step = 0; step < 4000; step++) {
                const {frames, subframes} = SMPTE.fromSeconds(step / 4000 * 3, FPS)
                expect(frames).toBeLessThan(FPS)
                expect(subframes).toBeLessThan(SMPTE.SubframesPerFrame)
            }
        })
    })

    describe("toShortString", () => {
        it("should format SMPTE as short string", () => {
            expect(SMPTE.toShortString(SMPTE.create(16))).toBe("16s")
            expect(SMPTE.toShortString(SMPTE.create(36, 12, 40))).toBe("36s 12fr 40sub")
        })
    })
})
