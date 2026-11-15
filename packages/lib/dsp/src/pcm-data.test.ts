import {describe, expect, it} from "vitest"
import {AudioData} from "./audio-data"
import {PcmData} from "./pcm-data"
import {WavFile} from "./wav-file"

const audioOf = (...channels: ReadonlyArray<ReadonlyArray<number>>): AudioData => {
    const audio = AudioData.create(44_100, channels[0].length, channels.length)
    channels.forEach((values, index) => audio.frames[index].set(values))
    return audio
}

// every int16 as the float a 16 bit WAV decodes to
const everyInt16 = (): AudioData => {
    const audio = AudioData.create(48_000, 65_536, 1)
    for (let value = -32_768; value < 32_768; value++) {audio.frames[0][value + 32_768] = value / 32_768}
    return audio
}

const bitsOf = (frames: Float32Array): Uint32Array => new Uint32Array(frames.buffer.slice(frames.byteOffset, frames.byteOffset + frames.byteLength))

describe("PcmData.isExact16", () => {
    it("accepts every int16 value", () => expect(PcmData.isExact16(everyInt16())).toBe(true))
    it("accepts silence", () => expect(PcmData.isExact16(audioOf([0, 0, 0]))).toBe(true))
    it("accepts an empty sample", () => expect(PcmData.isExact16(AudioData.create(48_000, 0, 2))).toBe(true))
    it("rejects a value between two steps", () => expect(PcmData.isExact16(audioOf([0.5, 0.5 + 1 / 65_536]))).toBe(false))
    it("rejects the smallest float next to a step", () =>
        expect(PcmData.isExact16(audioOf([Math.fround(0.25 + 2 ** -25)]))).toBe(false))
    it("rejects plus one, which 16 bit cannot hold", () => expect(PcmData.isExact16(audioOf([1.0]))).toBe(false))
    it("accepts minus one", () => expect(PcmData.isExact16(audioOf([-1.0]))).toBe(true))
    it("rejects values beyond full scale", () => {
        expect(PcmData.isExact16(audioOf([1.5]))).toBe(false)
        expect(PcmData.isExact16(audioOf([-1.5]))).toBe(false)
    })
    it("rejects NaN and infinities", () => {
        expect(PcmData.isExact16(audioOf([Number.NaN]))).toBe(false)
        expect(PcmData.isExact16(audioOf([Number.POSITIVE_INFINITY]))).toBe(false)
        expect(PcmData.isExact16(audioOf([Number.NEGATIVE_INFINITY]))).toBe(false)
    })
    it("rejects negative zero, it would come back positive", () => expect(PcmData.isExact16(audioOf([0, -0]))).toBe(false))
    it("looks at every channel", () => expect(PcmData.isExact16(audioOf([0.5, 0.25], [0.5, 0.3]))).toBe(false))
    it("rejects a value that is only exact in 24 bit", () => expect(PcmData.isExact16(audioOf([1 / 8_388_608]))).toBe(false))
})

describe("PcmData.smallest", () => {
    it("turns exact frames into 16 bit", () => {
        const pcm = PcmData.smallest(everyInt16())
        expect(pcm.format).toBe("int16")
        if (pcm.format !== "int16") {return}
        expect(pcm.frames[0][0]).toBe(-32_768)
        expect(pcm.frames[0][65_535]).toBe(32_767)
        expect(Array.from(pcm.frames[0].subarray(32_767, 32_770))).toEqual([-1, 0, 1])
    })
    it("keeps the float frames themselves when they are not exact", () => {
        const audio = audioOf([0.1, 0.2])
        const pcm = PcmData.smallest(audio)
        expect(pcm.format).toBe("float32")
        expect(pcm.frames[0]).toBe(audio.frames[0])
    })
    it("carries rate, frames and channels", () => {
        const pcm = PcmData.smallest(audioOf([0.5, 0.25, 0], [0, 0, 0]))
        expect([pcm.sampleRate, pcm.numberOfFrames, pcm.numberOfChannels]).toEqual([44_100, 3, 2])
    })
})

describe("PcmData.floats", () => {
    it("gives back every int16 value bit for bit", () => {
        const audio = everyInt16()
        const back = PcmData.floats(PcmData.smallest(audio))
        expect(bitsOf(back.frames[0])).toEqual(bitsOf(audio.frames[0]))
    })
    it("hands float frames through without a copy", () => {
        const audio = audioOf([0.1, 0.2])
        expect(PcmData.floats(PcmData.smallest(audio)).frames[0]).toBe(audio.frames[0])
    })
})

describe("PcmData.measure", () => {
    it("reports the peak over all channels", () => expect(PcmData.measure(audioOf([0.1, -0.5], [0.75, 0.2])).peak).toBe(0.75))
    it("reports exactness and peak in one pass", () => {
        expect(PcmData.measure(audioOf([0.5, -0.25]))).toEqual({exact16: true, peak: 0.5})
        expect(PcmData.measure(audioOf([0.5, 0.3])).exact16).toBe(false)
    })
    it("keeps measuring the peak after the first inexact value", () =>
        expect(PcmData.measure(audioOf([0.3, 1.25])).peak).toBe(1.25))
    it("treats NaN as beyond any peak", () => expect(PcmData.measure(audioOf([0.5, Number.NaN])).peak).toBe(Number.POSITIVE_INFINITY))
    it("agrees with isExact16 on negative zero", () => expect(PcmData.measure(audioOf([-0])).exact16).toBe(false))
})

describe("PcmData.quantize", () => {
    it("rounds to the nearest step", () => {
        const pcm = PcmData.quantize(audioOf([0.1, -0.1, 0.5]), 1.0)
        expect(pcm.format === "int16" && Array.from(pcm.frames[0])).toEqual([3277, -3277, 16_384])
    })
    it("clips what is beyond full scale", () => {
        const pcm = PcmData.quantize(audioOf([1.0, 2.0, -2.0]), 1.0)
        expect(pcm.format === "int16" && Array.from(pcm.frames[0])).toEqual([32_767, 32_767, -32_768])
    })
    it("applies the gain before rounding", () => {
        const pcm = PcmData.quantize(audioOf([1.01]), 1.0 / 1.01)
        expect(pcm.format === "int16" && pcm.frames[0][0]).toBe(32_767)
    })
})

describe("WavFile.isSixteenBit", () => {
    it("knows the header encodePcm writes", () =>
        expect(WavFile.isSixteenBit(new Uint8Array(WavFile.encodePcm(PcmData.smallest(audioOf([0.5, -0.5])))).subarray(0, 44))).toBe(true))
    it("says no to a float file, a 24 bit file, a short head and garbage", () => {
        expect(WavFile.isSixteenBit(new Uint8Array(WavFile.encodeFloats(audioOf([0.5]))))).toBe(false)
        expect(WavFile.isSixteenBit(new Uint8Array(WavFile.encodeInts24(audioOf([0.5]))))).toBe(false)
        expect(WavFile.isSixteenBit(new Uint8Array(WavFile.encodePcm(PcmData.smallest(audioOf([0.5])))).subarray(0, 43))).toBe(false)
        expect(WavFile.isSixteenBit(new Uint8Array(64))).toBe(false)
    })
    it("reads a head that sits inside a larger buffer", () => {
        const file = new Uint8Array(WavFile.encodePcm(PcmData.smallest(audioOf([0.5]))))
        const padded = new Uint8Array(file.byteLength + 8)
        padded.set(file, 8)
        expect(WavFile.isSixteenBit(padded.subarray(8))).toBe(true)
    })
})

describe("WavFile.encodePcm and decodePcm", () => {
    it("writes a canonical 16 bit header", () => {
        const view = new DataView(WavFile.encodePcm(PcmData.smallest(audioOf([0.5, -0.5, 0], [0.25, 0, -1]))))
        expect(view.byteLength).toBe(44 + 3 * 2 * 2)
        expect(view.getUint32(16, true)).toBe(16)
        expect(view.getUint16(20, true)).toBe(1)
        expect(view.getUint16(22, true)).toBe(2)
        expect(view.getUint32(24, true)).toBe(44_100)
        expect(view.getUint32(28, true)).toBe(44_100 * 2 * 2)
        expect(view.getUint16(32, true)).toBe(4)
        expect(view.getUint16(34, true)).toBe(16)
        expect(view.getUint32(40, true)).toBe(12)
        expect(view.getUint32(4, true)).toBe(view.byteLength - 8)
    })
    it("interleaves the channels", () => {
        const view = new DataView(WavFile.encodePcm(PcmData.smallest(audioOf([0.5, -0.5], [0.25, -1]))))
        expect([44, 46, 48, 50].map(offset => view.getInt16(offset, true))).toEqual([16_384, 8192, -16_384, -32_768])
    })
    it("decodes with decodeFloats to the very same floats, for every int16", () => {
        const audio = everyInt16()
        const decoded = WavFile.decodeFloats(WavFile.encodePcm(PcmData.smallest(audio)))
        expect(decoded.sampleRate).toBe(48_000)
        expect(bitsOf(decoded.frames[0])).toEqual(bitsOf(audio.frames[0]))
    })
    it("is half the size of the float file", () => {
        const audio = everyInt16()
        expect(WavFile.encodePcm(PcmData.smallest(audio)).byteLength - 44).toBe((WavFile.encodeFloats(audio).byteLength - 44) / 2)
    })
    it("writes inexact frames exactly as encodeFloats does", () => {
        const audio = audioOf([0.1, 0.2, -0.3])
        expect(new Uint8Array(WavFile.encodePcm(PcmData.smallest(audio)))).toEqual(new Uint8Array(WavFile.encodeFloats(audio)))
    })
    it("keeps 16 bit as 16 bit on the way back", () => {
        const pcm = WavFile.decodePcm(WavFile.encodePcm(PcmData.smallest(audioOf([0.5, -0.5], [0.25, -1]))))
        expect(pcm.format).toBe("int16")
        expect(pcm.format === "int16" && pcm.frames.map(plane => Array.from(plane))).toEqual([[16_384, -16_384], [8192, -32_768]])
        expect([pcm.sampleRate, pcm.numberOfFrames, pcm.numberOfChannels]).toEqual([44_100, 2, 2])
    })
    it("decodes a float file to floats", () => {
        const audio = audioOf([0.1, 0.2])
        const pcm = WavFile.decodePcm(WavFile.encodeFloats(audio))
        expect(pcm.format).toBe("float32")
        expect(Array.from(pcm.frames[0])).toEqual(Array.from(audio.frames[0]))
    })
    it("decodes a 24 bit file to floats", () => {
        const pcm = WavFile.decodePcm(WavFile.encodeInts24(audioOf([0.5, -0.25])))
        expect(pcm.format).toBe("float32")
    })
    it("survives an empty sample", () => {
        const pcm = WavFile.decodePcm(WavFile.encodePcm(PcmData.smallest(AudioData.create(48_000, 0, 2))))
        expect([pcm.format, pcm.numberOfFrames, pcm.numberOfChannels]).toEqual(["int16", 0, 2])
    })
    it("shows why encodeInts16 cannot store samples: it alters loud values", () => {
        const audio = audioOf([32_767 / 32_768])
        const viaOld = WavFile.decodeFloats(WavFile.encodeInts16(audio))
        const viaExact = WavFile.decodeFloats(WavFile.encodePcm(PcmData.smallest(audio)))
        expect(viaOld.frames[0][0]).not.toBe(audio.frames[0][0])
        expect(viaExact.frames[0][0]).toBe(audio.frames[0][0])
    })
})
