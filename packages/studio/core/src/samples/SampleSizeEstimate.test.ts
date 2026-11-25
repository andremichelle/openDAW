import {describe, expect, it} from "vitest"
import {Blob as NodeBlob} from "node:buffer"
import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
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

// jsdom's Blob has no arrayBuffer(), node's has
const blob = (buffer: ArrayBuffer): Blob => new NodeBlob([buffer])

const stored = (frames: number, channels: number, bytesPerSample: number): number =>
    44 + frames * channels * bytesPerSample + SampleSizeEstimate.peakBytes(frames, channels) + 512

describe("SampleSizeEstimate.peakBytes", () => {
    it("matches the size SamplePeaks serialises", () => {
        for (const [frames, channels] of [[100, 1], [44100, 2], [1_000_000, 2]]) {
            const shifts = Array.from(SamplePeaks.findBestFit(frames))
            const offsets = shifts.reduce<Array<number>>((list, shift, index) =>
                [...list, (list[index] ?? 0) + Math.ceil(frames / (1 << shift))], [0])
            const stages = shifts.map((shift, index) =>
                new Peaks.Stage(shift, Math.ceil(frames / (1 << shift)), offsets[index]))
            const data = Array.from({length: channels}, () => new Int32Array(offsets[shifts.length]))
            expect(SampleSizeEstimate.peakBytes(frames, channels))
                .toBe(new SamplePeaks(stages, data, frames, channels).toArrayBuffer().byteLength)
        }
    })
})

describe("SampleSizeEstimate.of", () => {
    it("stores a 16 bit wav as int16 when the storage keeps the smallest format", async () => {
        // the file ends before the data, the data chunk size alone tells the length
        expect(await SampleSizeEstimate.of(blob(wavHeader(1, 16, 2, 44100, 1000)), 48000, true))
            .toEqual({bytes: stored(1000, 2, 2), exact: true})
        expect(await SampleSizeEstimate.of(blob(wavHeader(1, 16, 2, 44100, 1000)), 48000, false))
            .toEqual({bytes: stored(1000, 2, 4), exact: true})
    })
    it("stores 24 bit and float wavs as float32 at their own rate", async () => {
        expect(await SampleSizeEstimate.of(blob(wavHeader(1, 24, 1, 96000, 500)), 48000, true))
            .toEqual({bytes: stored(500, 1, 4), exact: true})
        expect(await SampleSizeEstimate.of(blob(wavHeader(3, 32, 2, 44100, 500)), 48000, true))
            .toEqual({bytes: stored(500, 2, 4), exact: true})
    })
    it("resamples a wav the built-in decoder cannot read (8 bit) to the decode rate", async () => {
        expect(await SampleSizeEstimate.of(blob(wavHeader(1, 8, 1, 24000, 1000)), 48000, true))
            .toEqual({bytes: stored(2000, 1, 4), exact: true})
    })
    it("finds the data chunk behind metadata chunks larger than the header slice", async () => {
        const junk = 100_000
        const buffer = bytes(36 + 8 + junk + 8, view => {
            const header = new DataView(wavHeader(1, 16, 2, 44100, 1000))
            for (let index = 0; index < 36; index++) {view.setUint8(index, header.getUint8(index))}
            text(view, 36, "JUNK")
            view.setUint32(40, junk, true)
            text(view, 44 + junk, "data")
            view.setUint32(48 + junk, 4000, true)
        })
        expect(await SampleSizeEstimate.of(blob(buffer), 48000, true))
            .toEqual({bytes: stored(1000, 2, 2), exact: true})
    })
    it("reads frames, channels and rate from an aiff COMM chunk", async () => {
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
        expect(await SampleSizeEstimate.of(blob(header), 48000, true))
            .toEqual({bytes: stored(48000, 2, 4), exact: true})
    })
    it("reads the total samples from flac STREAMINFO", async () => {
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
        expect(await SampleSizeEstimate.of(blob(header), 48000, true))
            .toEqual({bytes: stored(96000, 2, 4), exact: true})
    })
    it("estimates an mp3 from the bitrate of its first frame, also behind a tag larger than the header slice", async () => {
        // MPEG-1 layer 3, 128 kbit/s, 44100 Hz, stereo
        for (const tag of [0, 100_000]) {
            const buffer = bytes(10 + tag + 16_000, view => {
                text(view, 0, "ID3")
                view.setUint8(6, (tag >> 21) & 0x7f)
                view.setUint8(7, (tag >> 14) & 0x7f)
                view.setUint8(8, (tag >> 7) & 0x7f)
                view.setUint8(9, tag & 0x7f)
                view.setUint32(10 + tag, 0xfffb9000)
            })
            expect(await SampleSizeEstimate.of(blob(buffer), 48000, true))
                .toEqual({bytes: stored(48000, 2, 4), exact: false})
        }
    })
    it("falls back to an assumed bitrate for formats without a readable duration", async () => {
        expect(await SampleSizeEstimate.of(blob(new ArrayBuffer(20_000)), 48000, true))
            .toEqual({bytes: stored(48000, 2, 4), exact: false})
    })
})
