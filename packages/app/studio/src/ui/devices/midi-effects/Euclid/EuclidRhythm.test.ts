import {describe, expect, it} from "vitest"
import {EuclidRhythm} from "./EuclidRhythm"

const pattern = (cells: ReadonlyArray<boolean>): string => cells.map(cell => cell ? "x" : ".").join("")

describe("EuclidRhythm", () => {
    it("spreads the pulses as the classic Euclidean rhythms, the first on step 0", () => {
        expect(pattern(EuclidRhythm.spread(8, 3, 0))).toBe("x..x..x.")
        expect(pattern(EuclidRhythm.spread(16, 4, 0))).toBe("x...x...x...x...")
        expect(pattern(EuclidRhythm.spread(8, 5, 0))).toBe("x.xx.xx.")
        expect(pattern(EuclidRhythm.spread(9, 4, 0))).toBe("x.x.x.x..")
        expect(pattern(EuclidRhythm.spread(12, 5, 0))).toBe("x..x.x..x.x.")
        expect(pattern(EuclidRhythm.spread(16, 7, 0))).toBe("x..x.x.x..x.x.x.")
        expect(pattern(EuclidRhythm.spread(13, 5, 0))).toBe("x..x.x..x.x..")
        expect(pattern(EuclidRhythm.spread(5, 0, 0))).toBe(".....")
        expect(pattern(EuclidRhythm.spread(4, 9, 0))).toBe("xxxx")
    })

    it("rotates the hits to the right and wraps around", () => {
        expect(pattern(EuclidRhythm.spread(8, 3, 1))).toBe(".x..x..x")
        expect(pattern(EuclidRhythm.spread(8, 3, -1))).toBe("..x..x.x")
        expect(pattern(EuclidRhythm.spread(8, 3, 9))).toBe(".x..x..x")
    })

    it("spreads accents and bursts over the hits, not over the steps", () => {
        const steps = EuclidRhythm.steps({steps: 8, pulses: 4, rotate: 0, accents: 2, accentRotate: 0, bursts: 1, burstRotate: 1})
        expect(pattern(steps.map(step => step.hit))).toBe("x.x.x.x.")
        expect(pattern(steps.map(step => step.accent))).toBe("x...x...")
        expect(pattern(steps.map(step => step.burst))).toBe("..x.....")
    })

    it("has no accents or bursts on a lane without hits", () => {
        const steps = EuclidRhythm.steps({steps: 4, pulses: 0, rotate: 0, accents: 3, accentRotate: 0, bursts: 3, burstRotate: 0})
        expect(steps.some(step => step.hit || step.accent || step.burst)).toBe(false)
    })
})
