import {describe, expect, it} from "vitest"
import {ChannelMapping} from "./ChannelMapping"

describe("ChannelMapping", () => {
    it("builds pairs and single inputs from a zero-based input index", () => {
        expect(ChannelMapping.stereo(0)).toEqual(ChannelMapping.Stereo)
        expect(ChannelMapping.stereo(2)).toEqual({left: 0b0100, right: 0b1000})
        expect(ChannelMapping.mono(1)).toEqual({left: 0b10, right: 0})
    })

    it("counts outputs and the inputs a mapping reaches", () => {
        expect(ChannelMapping.outputCount(ChannelMapping.Stereo)).toBe(2)
        expect(ChannelMapping.outputCount(ChannelMapping.MonoMixed)).toBe(1)
        expect(ChannelMapping.inputCount(ChannelMapping.mono(0))).toBe(1)
        expect(ChannelMapping.inputCount(ChannelMapping.mono(4))).toBe(5)
        expect(ChannelMapping.inputCount(ChannelMapping.stereo(2))).toBe(4)
        expect(ChannelMapping.inputCount({left: 0, right: 0})).toBe(0)
    })

    it("lists the input indices of a side", () => {
        expect(ChannelMapping.indices(0)).toEqual([])
        expect(ChannelMapping.indices(0b1)).toEqual([0])
        expect(ChannelMapping.indices(0b1011)).toEqual([0, 1, 3])
        expect(ChannelMapping.indices(1 << 30)).toEqual([30])
    })

    it("handles the highest input, whose bit is the sign bit", () => {
        const mapping = ChannelMapping.mono(31)
        expect(mapping.left).toBeLessThan(0)
        expect(ChannelMapping.inputCount(mapping)).toBe(32)
        expect(ChannelMapping.indices(mapping.left)).toEqual([31])
    })

    it("keeps a mapping the stream fully delivers", () => {
        expect(ChannelMapping.fit(ChannelMapping.Stereo, 2)).toEqual(ChannelMapping.Stereo)
        expect(ChannelMapping.fit(ChannelMapping.stereo(2), 4)).toEqual(ChannelMapping.stereo(2))
    })

    it("drops inputs the stream lacks and gives an empty left the first input", () => {
        expect(ChannelMapping.fit(ChannelMapping.Stereo, 1)).toEqual({left: 0b1, right: 0})
        expect(ChannelMapping.fit(ChannelMapping.mono(1), 1)).toEqual({left: 0b1, right: 0})
        expect(ChannelMapping.fit(ChannelMapping.stereo(2), 2)).toEqual({left: 0b1, right: 0})
        expect(ChannelMapping.fit(ChannelMapping.stereo(2), 3)).toEqual({left: 0b100, right: 0})
        expect(ChannelMapping.fit({left: 0b101, right: 0b10}, 2)).toEqual({left: 0b1, right: 0b10})
    })

    it("treats a stream reporting no channels as one", () => {
        expect(ChannelMapping.fit(ChannelMapping.Stereo, 0)).toEqual({left: 0b1, right: 0})
    })

    it("compares by both sides", () => {
        expect(ChannelMapping.equals(ChannelMapping.Stereo, {left: 1, right: 2})).toBe(true)
        expect(ChannelMapping.equals(ChannelMapping.Stereo, ChannelMapping.MonoMixed)).toBe(false)
    })
})
