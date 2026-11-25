import {describe, expect, it} from "vitest"
import {AudioData} from "./audio-data"
import {WavFile} from "./wav-file"

const createAudio = (numberOfChannels: number, samples: ReadonlyArray<number>): AudioData => {
    const audio = AudioData.create(48_000, samples.length, numberOfChannels)
    for (let channel = 0; channel < numberOfChannels; channel++) {
        audio.frames[channel].set(samples.map(sample => channel === 0 ? sample : -sample))
    }
    return audio
}

describe("WavFile", () => {
    const samples = [0.0, 0.5, -0.5, 1.0, -1.0, 0.25, -0.125]
    it("writes a 24-bit PCM header", () => {
        const view = new DataView(WavFile.encodeInts24(createAudio(2, samples)))
        expect(view.getUint16(20, true)).toBe(1)
        expect(view.getUint16(22, true)).toBe(2)
        expect(view.getUint32(24, true)).toBe(48_000)
        expect(view.getUint32(28, true)).toBe(48_000 * 2 * 3)
        expect(view.getUint16(32, true)).toBe(6)
        expect(view.getUint16(34, true)).toBe(24)
        expect(view.getUint32(40, true)).toBe(samples.length * 2 * 3)
    })
    it("round-trips 24-bit within one quantisation step", () => {
        const decoded = WavFile.decodeFloats(WavFile.encodeInts24(createAudio(2, samples)))
        expect(decoded.numberOfFrames).toBe(samples.length)
        samples.forEach((sample, index) => {
            expect(Math.abs(decoded.frames[0][index] - sample)).toBeLessThanOrEqual(1 / 0x7fffff)
            expect(Math.abs(decoded.frames[1][index] + sample)).toBeLessThanOrEqual(1 / 0x7fffff)
        })
    })
    it("encodes 24-bit extremes and negative values in two's complement", () => {
        const view = new DataView(WavFile.encodeInts24(createAudio(1, [1.0, -1.0, -1.0 / 0x7fffff, 2.0, -2.0])))
        const read = (index: number) => {
            const offset = 44 + index * 3
            return view.getInt8(offset + 2) * 65536 + view.getUint16(offset, true)
        }
        expect(read(0)).toBe(0x7fffff)
        expect(read(1)).toBe(-0x7fffff)
        expect(read(2)).toBe(-1)
        expect(read(3)).toBe(0x7fffff)
        expect(read(4)).toBe(-0x7fffff)
    })
    it("pads odd-sized 24-bit data chunks to an even byte count", () => {
        const buffer = WavFile.encodeInts24(createAudio(1, [0.1, 0.2, 0.3]))
        const view = new DataView(buffer)
        expect(view.getUint32(40, true)).toBe(9)
        expect(buffer.byteLength).toBe(44 + 10)
        expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8)
        expect(WavFile.decodeFloats(buffer).numberOfFrames).toBe(3)
    })
    it("round-trips 16-bit within one quantisation step", () => {
        const decoded = WavFile.decodeFloats(WavFile.encodeInts16(createAudio(2, samples)))
        samples.forEach((sample, index) => {
            expect(Math.abs(decoded.frames[0][index] - sample)).toBeLessThanOrEqual(1 / 0x7fff)
        })
    })
    it("round-trips 32-bit float exactly", () => {
        const decoded = WavFile.decodeFloats(WavFile.encodeFloats(createAudio(2, samples)))
        samples.forEach((sample, index) => expect(decoded.frames[0][index]).toBe(Math.fround(sample)))
    })
})
