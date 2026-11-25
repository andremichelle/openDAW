import {describe, expect, it} from "vitest"
import {SampleSizeEstimate} from "./SampleSizeEstimate"

const bytes = (size: number, write: (view: DataView) => void): ArrayBuffer => {
    const buffer = new ArrayBuffer(size)
    write(new DataView(buffer))
    return buffer
}

const text = (view: DataView, offset: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))

const wavHeader = (format: number, bits: number, channels: number, rate: number, frames: number): ArrayBuffer =>
    bytes(44, view => {
        const blockAlign = channels * bits / 8
        text(view, 0, "RIFF")
        view.setUint32(4, 36 + frames * blockAlign, true)
        text(view, 8, "WAVE")
        text(view, 12, "fmt ")
        view.setUint32(16, 16, true)
        view.setUint16(20, format, true)
        view.setUint16(22, channels, true)
        view.setUint32(24, rate, true)
        view.setUint32(28, rate * blockAlign, true)
        view.setUint16(32, blockAlign, true)
        view.setUint16(34, bits, true)
        text(view, 36, "data")
        view.setUint32(40, frames * blockAlign, true)
    })

describe("SampleSizeEstimate.of", () => {
    it("stores a 16 bit wav as int16 when the storage keeps the smallest format", () => {
        // the header slice ends before the data, the data chunk size alone tells the length
        expect(SampleSizeEstimate.of(wavHeader(1, 16, 2, 44100, 1000), 4044, 48000, true))
            .toEqual({bytes: 44 + 1000 * 2 * 2, exact: true})
        expect(SampleSizeEstimate.of(wavHeader(1, 16, 2, 44100, 1000), 4044, 48000, false))
            .toEqual({bytes: 44 + 1000 * 2 * 4, exact: true})
    })
    it("stores 24 bit and float wavs as float32 at their own rate", () => {
        expect(SampleSizeEstimate.of(wavHeader(1, 24, 1, 96000, 500), 1544, 48000, true))
            .toEqual({bytes: 44 + 500 * 4, exact: true})
        expect(SampleSizeEstimate.of(wavHeader(3, 32, 2, 44100, 500), 4044, 48000, true))
            .toEqual({bytes: 44 + 500 * 2 * 4, exact: true})
    })
    it("resamples a wav the built-in decoder cannot read (8 bit) to the decode rate", () => {
        expect(SampleSizeEstimate.of(wavHeader(1, 8, 1, 24000, 1000), 1044, 48000, true))
            .toEqual({bytes: 44 + 2000 * 4, exact: true})
    })
    it("reads frames, channels and rate from an aiff COMM chunk", () => {
        const header = bytes(38, view => {
            text(view, 0, "FORM")
            text(view, 8, "AIFF")
            text(view, 12, "COMM")
            view.setUint32(16, 18)
            view.setUint16(20, 2)
            view.setUint32(22, 44100)
            view.setUint16(26, 16)
            // 44100 as 80 bit extended float
            view.setUint16(28, 0x400e)
            view.setUint32(30, 0xac440000)
        })
        expect(SampleSizeEstimate.of(header, 200_000, 48000, true))
            .toEqual({bytes: 44 + 48000 * 2 * 4, exact: true})
    })
    it("reads the total samples from flac STREAMINFO", () => {
        const header = bytes(42, view => {
            text(view, 0, "fLaC")
            // sample rate 44100 (20 bits), 2 channels, 16 bits, 88200 total samples
            const rate = 44100
            view.setUint8(18, (rate >> 12) & 0xff)
            view.setUint8(19, (rate >> 4) & 0xff)
            view.setUint8(20, ((rate & 0x0f) << 4) | (1 << 1))
            view.setUint8(21, (15 << 4) & 0xf0)
            view.setUint32(22, 88200)
        })
        expect(SampleSizeEstimate.of(header, 300_000, 48000, true))
            .toEqual({bytes: 44 + 96000 * 2 * 4, exact: true})
    })
    it("estimates an mp3 from the bitrate of its first frame", () => {
        // MPEG-1 layer 3, 128 kbit/s, 44100 Hz, stereo, behind a 10 byte ID3 tag with no content
        const header = bytes(14, view => {
            text(view, 0, "ID3")
            view.setUint32(10, 0xfffb9000)
        })
        const fileSize = 10 + 16_000
        expect(SampleSizeEstimate.of(header, fileSize, 48000, true))
            .toEqual({bytes: 44 + 48000 * 2 * 4, exact: false})
    })
    it("falls back to an assumed bitrate for formats without a readable duration", () => {
        expect(SampleSizeEstimate.of(new ArrayBuffer(16), 20_000, 48000, true))
            .toEqual({bytes: 44 + 48000 * 2 * 4, exact: false})
    })
})
