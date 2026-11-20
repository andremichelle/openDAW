// A render cut at the length limit fades out over the last second instead of stopping hard.
import {describe, expect, it} from "vitest"
import {FadeOut} from "../src/fade-out"

describe("FadeOut", () => {
    it("ramps the last frames from full level down to zero", () => {
        const channels = [new Float32Array(10).fill(1.0), new Float32Array(10).fill(-0.5)]
        FadeOut.apply(channels, 4)
        expect(Array.from(channels[0].subarray(0, 6))).toEqual([1, 1, 1, 1, 1, 1])
        expect(Array.from(channels[0].subarray(6))).toEqual([0.75, 0.5, 0.25, 0])
        expect(Array.from(channels[1].subarray(6))).toEqual([-0.375, -0.25, -0.125, -0])
    })
    it("fades the whole signal when it is shorter than the fade", () => {
        const channels = [new Float32Array(2).fill(1.0)]
        FadeOut.apply(channels, 4)
        expect(Array.from(channels[0])).toEqual([0.5, 0])
    })
    it("leaves an empty signal alone", () => {
        const channels = [new Float32Array(0)]
        FadeOut.apply(channels, 4)
        expect(channels[0].length).toBe(0)
    })
})
