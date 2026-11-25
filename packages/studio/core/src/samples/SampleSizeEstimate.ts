import {int, isDefined, Option, Provider} from "@opendaw/lib-std"
import {SamplePeaks} from "@opendaw/lib-fusion"
import {AssetService} from "../AssetService"

export namespace SampleSizeEstimate {
    type Shape = {
        readonly frames: number
        readonly channels: int
        readonly sampleRate: number
        readonly bytesPerSample: int
        readonly resampled: boolean
        readonly exact: boolean
    }

    const HeaderBytes = 1 << 16
    const WavHeaderBytes = 44
    // meta.json written next to every sample
    const MetaBytes = 512
    // assumed for compressed audio whose header tells no duration (160 kbit/s)
    const FallbackBytesPerSecond = 20_000

    const ascii = (view: DataView, offset: int, text: string): boolean =>
        offset + text.length <= view.byteLength
        && [...text].every((char, index) => view.getUint8(offset + index) === char.charCodeAt(0))

    const at = async (blob: Blob, head: DataView, offset: number, length: int): Promise<DataView> =>
        offset + length <= head.byteLength
            ? new DataView(head.buffer, offset, length)
            : new DataView(await blob.slice(offset, offset + length).arrayBuffer())

    export const peakBytes = (frames: number, channels: int): number => {
        const shifts = Array.from(SamplePeaks.findBestFit(frames))
        const peaks = shifts.reduce((sum, shift) => sum + Math.ceil(frames / (1 << shift)), 0)
        return 14 + 4 + shifts.length * 16 + 4 + channels * (4 + peaks * 4) + 8
    }

    const wav = async (blob: Blob, head: DataView, smallest: boolean): Promise<Option<Shape>> => {
        if (!ascii(head, 0, "RIFF") || !ascii(head, 8, "WAVE")) {return Option.None}
        const chunks = {fmt: -1, dataSize: -1}
        for (let offset = 12; offset + 8 <= blob.size && (chunks.fmt < 0 || chunks.dataSize < 0);) {
            const chunk = await at(blob, head, offset, 8)
            const size = chunk.getUint32(4, true)
            if (ascii(chunk, 0, "fmt ")) {chunks.fmt = offset + 8}
            if (ascii(chunk, 0, "data")) {chunks.dataSize = size}
            offset += 8 + ((size + 1) & ~1)
        }
        if (chunks.fmt < 0 || chunks.dataSize < 0) {return Option.None}
        const fmt = await at(blob, head, chunks.fmt, 16)
        const format = fmt.getUint16(0, true)
        const channels = fmt.getUint16(2, true)
        const sampleRate = fmt.getUint32(4, true)
        const blockAlign = fmt.getUint16(12, true)
        const bits = fmt.getUint16(14, true)
        if (blockAlign === 0 || channels === 0) {return Option.None}
        const frames = Math.floor(chunks.dataSize / blockAlign)
        const decodable = (format === 3 && bits === 32) || (format === 1 && (bits === 16 || bits === 24))
        const int16 = smallest && format === 1 && bits === 16
        return Option.wrap({frames, channels, sampleRate, bytesPerSample: int16 ? 2 : 4, resampled: !decodable, exact: true})
    }

    const extended = (view: DataView, offset: int): number => {
        const exponent = (view.getUint16(offset) & 0x7fff) - 16383
        return view.getUint32(offset + 2) * Math.pow(2, exponent - 31)
    }

    const aiff = async (blob: Blob, head: DataView): Promise<Option<Shape>> => {
        if (!ascii(head, 0, "FORM") || !(ascii(head, 8, "AIFF") || ascii(head, 8, "AIFC"))) {return Option.None}
        for (let offset = 12; offset + 26 <= blob.size;) {
            const chunk = await at(blob, head, offset, 26)
            if (ascii(chunk, 0, "COMM")) {
                return Option.wrap({
                    channels: chunk.getUint16(8),
                    frames: chunk.getUint32(10),
                    sampleRate: extended(chunk, 16),
                    bytesPerSample: 4, resampled: true, exact: true
                })
            }
            offset += 8 + ((chunk.getUint32(4) + 1) & ~1)
        }
        return Option.None
    }

    const flac = async (view: DataView): Promise<Option<Shape>> => {
        if (!ascii(view, 0, "fLaC") || view.byteLength < 26) {return Option.None}
        const info = 8
        const sampleRate = (view.getUint8(info + 10) << 12) | (view.getUint8(info + 11) << 4) | (view.getUint8(info + 12) >> 4)
        const channels = ((view.getUint8(info + 12) >> 1) & 0x07) + 1
        const frames = (view.getUint8(info + 13) & 0x0f) * 0x1_0000_0000 + view.getUint32(info + 14)
        if (frames === 0 || sampleRate === 0) {return Option.None}
        return Option.wrap({frames, channels, sampleRate, bytesPerSample: 4, resampled: true, exact: true})
    }

    const Mp3Bitrates: ReadonlyArray<int> = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    const Mp3SampleRates: ReadonlyArray<int> = [44100, 48000, 32000]

    const mp3 = async (blob: Blob, head: DataView): Promise<Option<Shape>> => {
        const start = ascii(head, 0, "ID3") && head.byteLength >= 10
            ? 10 + ((head.getUint8(6) & 0x7f) << 21 | (head.getUint8(7) & 0x7f) << 14
            | (head.getUint8(8) & 0x7f) << 7 | (head.getUint8(9) & 0x7f))
            : 0
        if (start + 4 > blob.size) {return Option.None}
        const header = (await at(blob, head, start, 4)).getUint32(0)
        const mpeg1Layer3 = (header >>> 21) === 0x7ff && ((header >>> 19) & 0x03) === 0x03 && ((header >>> 17) & 0x03) === 0x01
        if (!mpeg1Layer3) {return Option.None}
        const bitrate = Mp3Bitrates[(header >>> 12) & 0x0f]
        const sampleRate = Mp3SampleRates[(header >>> 10) & 0x03]
        if (!isDefined(bitrate) || bitrate === 0 || !isDefined(sampleRate)) {return Option.None}
        const channels = ((header >>> 6) & 0x03) === 0x03 ? 1 : 2
        const seconds = (blob.size - start) * 8 / (bitrate * 1000)
        return Option.wrap({frames: seconds * sampleRate, channels, sampleRate, bytesPerSample: 4, resampled: true, exact: false})
    }

    const stored = (frames: number, channels: int, bytesPerSample: int): number =>
        WavHeaderBytes + frames * channels * bytesPerSample + peakBytes(frames, channels) + MetaBytes

    export const of = async (blob: Blob, decodeRate: number, smallest: boolean): Promise<AssetService.SizeEstimate> => {
        const head = new DataView(await blob.slice(0, HeaderBytes).arrayBuffer())
        const parsers: ReadonlyArray<Provider<Promise<Option<Shape>>>> =
            [() => wav(blob, head, smallest), () => aiff(blob, head), () => flac(head), () => mp3(blob, head)]
        const found: { shape: Option<Shape> } = {shape: Option.None}
        for (const parse of parsers) {
            if (found.shape.nonEmpty()) {break}
            found.shape = await parse()
        }
        return found.shape.match({
            none: () => ({bytes: stored(Math.round(blob.size / FallbackBytesPerSecond * decodeRate), 2, 4), exact: false}),
            some: ({frames, channels, sampleRate, bytesPerSample, resampled, exact}) => ({
                bytes: stored(resampled ? Math.round(frames * decodeRate / sampleRate) : Math.round(frames), channels, bytesPerSample),
                exact
            })
        })
    }
}
