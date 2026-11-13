import {describe, expect, it} from "vitest"
import {AudioData} from "./audio-data"
import {PcmData} from "./pcm-data"
import {SampleConversion} from "./sample-conversion"
import {WavFile} from "./wav-file"

const floats = (...channels: ReadonlyArray<ReadonlyArray<number>>): PcmData => {
    const audio = AudioData.create(48_000, channels[0].length, channels.length)
    channels.forEach((values, index) => audio.frames[index].set(values))
    return {format: "float32", ...audio}
}

const written = (pcm: PcmData): Array<number> => {
    const converted = SampleConversion.convert(pcm).unwrap()
    return converted.format === "int16" ? Array.from(converted.frames[0]) : []
}

describe("SampleConversion.judge", () => {
    it("knows a 16 bit sample and its peak", () => {
        const pcm = PcmData.smallest(PcmData.floats(floats([0.5, -0.75, 0.25])))
        expect(SampleConversion.judge(pcm)).toEqual({kind: "sixteen", peak: 0.75})
    })
    it("calls frames 16 bit holds exactly exact", () =>
        expect(SampleConversion.judge(floats([0.5, -0.25, 0])).kind).toBe("exact"))
    it("calls inexact frames below full scale rounding", () =>
        expect(SampleConversion.judge(floats([0.1, -0.9])).kind).toBe("rounding"))
    it("counts exactly full scale as rounding, 16 bit ends one step below", () =>
        expect(SampleConversion.judge(floats([1.0, 0.5]))).toEqual({kind: "rounding", peak: 1.0}))
    it("counts negative zero as rounding", () => expect(SampleConversion.judge(floats([0.5, -0])).kind).toBe("rounding"))
    it("calls a peak up to 0.1 dB above full scale scaling", () => {
        expect(SampleConversion.judge(floats([1.005, -0.3])).kind).toBe("scaling")
        expect(SampleConversion.judge(floats([-1.0115, 0.3])).kind).toBe("scaling")
    })
    it("leaves anything louder as float", () => {
        expect(SampleConversion.judge(floats([1.012, -0.3])).kind).toBe("float")
        expect(SampleConversion.judge(floats([0.2, -4.0])).kind).toBe("float")
    })
    it("leaves frames with NaN or infinity as float", () => {
        expect(SampleConversion.judge(floats([0.1, Number.NaN])).kind).toBe("float")
        expect(SampleConversion.judge(floats([Number.POSITIVE_INFINITY])).kind).toBe("float")
    })
    it("puts the headroom at 0.1 dB", () => {
        expect(SampleConversion.Headroom).toBeCloseTo(1.011579, 5)
        expect(20 * Math.log10(SampleConversion.Headroom)).toBeCloseTo(0.1, 9)
    })
    it("looks at the loudest channel", () =>
        expect(SampleConversion.judge(floats([0.1, 0.2], [0.3, 1.01]))).toEqual({kind: "scaling", peak: Math.fround(1.01)}))
    it("says which kinds convert", () => {
        expect((["sixteen", "exact", "rounding", "scaling", "float"] as const).map(SampleConversion.isConvertible))
            .toEqual([false, true, true, true, false])
    })
})

describe("SampleConversion.convert", () => {
    it("does nothing for 16 bit and for samples that stay float", () => {
        expect(SampleConversion.convert(PcmData.smallest(PcmData.floats(floats([0.5])))).isEmpty()).toBe(true)
        expect(SampleConversion.convert(floats([2.0])).isEmpty()).toBe(true)
    })
    it("writes exact frames without touching a value", () => {
        const pcm = floats([0.5, -0.25, 32_767 / 32_768, -1])
        expect(written(pcm)).toEqual([16_384, -8192, 32_767, -32_768])
        const back = PcmData.floats(SampleConversion.convert(pcm).unwrap())
        expect(Array.from(back.frames[0])).toEqual(Array.from(PcmData.floats(pcm).frames[0]))
    })
    it("rounds inexact frames to the nearest step, at most half a step away", () => {
        const values = [0.1, -0.33333, 0.77777, -0.00001]
        const converted = PcmData.floats(SampleConversion.convert(floats(values)).unwrap())
        values.forEach((value, index) => expect(Math.abs(converted.frames[0][index] - Math.fround(value))).toBeLessThanOrEqual(0.5 / 32_768))
    })
    it("rounds full scale to the last step", () => expect(written(floats([1.0, -1.0]))).toEqual([32_767, -32_768]))
    it("lowers a sample above full scale so its peak is the last step, nothing clips", () => {
        const pcm = floats([1.01, 0.0, -1.01, 0.25])
        expect(written(pcm)).toEqual([32_767, 0, -32_767, Math.round(0.25 / Math.fround(1.01) * 32_767)])
    })
    it("lowers by no more than the headroom", () => {
        const verdict = SampleConversion.judge(floats([1.01157]))
        expect(verdict.kind).toBe("scaling")
        expect(-20 * Math.log10(SampleConversion.gainOf(verdict))).toBeLessThan(0.1003)
    })
    it("applies no gain unless the sample is above full scale", () => {
        expect(SampleConversion.gainOf({kind: "rounding", peak: 0.3})).toBe(1.0)
        expect(SampleConversion.gainOf({kind: "exact", peak: 0.3})).toBe(1.0)
    })
    it("converting twice changes nothing more", () => {
        const once = SampleConversion.convert(floats([0.1, -0.7, 1.0])).unwrap()
        expect(SampleConversion.convert(once).isEmpty()).toBe(true)
        expect(SampleConversion.judge(once).kind).toBe("sixteen")
        const reread = WavFile.decodePcm(WavFile.encodePcm(once))
        expect(reread.format === "int16" && once.format === "int16" && Array.from(reread.frames[0])).toEqual(
            once.format === "int16" ? Array.from(once.frames[0]) : [])
    })
    it("keeps rate, frames and channels", () => {
        const converted = SampleConversion.convert(floats([0.1, 0.2], [0.3, 0.4])).unwrap()
        expect([converted.sampleRate, converted.numberOfFrames, converted.numberOfChannels]).toEqual([48_000, 2, 2])
    })
    it("knows the size of the file afterwards", () =>
        expect(SampleConversion.bytesAfter({sampleRate: 48_000, numberOfFrames: 100, numberOfChannels: 2})).toBe(444))
})
