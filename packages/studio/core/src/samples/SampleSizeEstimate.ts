import {int, isDefined, Option, Provider} from "@opendaw/lib-std"

export namespace SampleSizeEstimate {
    export type Estimate = { readonly bytes: number, readonly exact: boolean }

    type Shape = {
        readonly frames: number
        readonly channels: int
        readonly sampleRate: number
        readonly bytesPerSample: int
        readonly resampled: boolean
        readonly exact: boolean
    }

    export const HeaderBytes = 1 << 16
    const WavHeaderBytes = 44
    // assumed for compressed audio whose header tells no duration (160 kbit/s)
    const FallbackBytesPerSecond = 20_000

    const ascii = (view: DataView, offset: int, text: string): boolean =>
        offset + text.length <= view.byteLength
        && [...text].every((char, index) => view.getUint8(offset + index) === char.charCodeAt(0))

    const wav = (view: DataView, smallest: boolean): Option<Shape> => {
        if (!ascii(view, 0, "RIFF") || !ascii(view, 8, "WAVE")) {return Option.None}
        const fmt = {offset: -1}
        const data = {size: -1}
        for (let offset = 12; offset + 8 <= view.byteLength;) {
            const size = view.getUint32(offset + 4, true)
            if (ascii(view, offset, "fmt ")) {fmt.offset = offset + 8}
            if (ascii(view, offset, "data")) {data.size = size}
            offset += 8 + ((size + 1) & ~1)
        }
        if (fmt.offset < 0 || fmt.offset + 16 > view.byteLength || data.size < 0) {return Option.None}
        const format = view.getUint16(fmt.offset, true)
        const channels = view.getUint16(fmt.offset + 2, true)
        const sampleRate = view.getUint32(fmt.offset + 4, true)
        const blockAlign = view.getUint16(fmt.offset + 12, true)
        const bits = view.getUint16(fmt.offset + 14, true)
        if (blockAlign === 0 || channels === 0) {return Option.None}
        const frames = Math.floor(data.size / blockAlign)
        const decodable = (format === 3 && bits === 32) || (format === 1 && (bits === 16 || bits === 24))
        const int16 = smallest && format === 1 && bits === 16
        return Option.wrap({frames, channels, sampleRate, bytesPerSample: int16 ? 2 : 4, resampled: !decodable, exact: true})
    }

    const extended = (view: DataView, offset: int): number => {
        const exponent = (view.getUint16(offset) & 0x7fff) - 16383
        return view.getUint32(offset + 2) * Math.pow(2, exponent - 31)
    }

    const aiff = (view: DataView): Option<Shape> => {
        if (!ascii(view, 0, "FORM") || !(ascii(view, 8, "AIFF") || ascii(view, 8, "AIFC"))) {return Option.None}
        for (let offset = 12; offset + 8 <= view.byteLength;) {
            const size = view.getUint32(offset + 4)
            if (ascii(view, offset, "COMM") && offset + 26 <= view.byteLength) {
                return Option.wrap({
                    channels: view.getUint16(offset + 8),
                    frames: view.getUint32(offset + 10),
                    sampleRate: extended(view, offset + 16),
                    bytesPerSample: 4, resampled: true, exact: true
                })
            }
            offset += 8 + ((size + 1) & ~1)
        }
        return Option.None
    }

    const flac = (view: DataView): Option<Shape> => {
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

    const mp3 = (view: DataView, fileSize: number): Option<Shape> => {
        const start = ascii(view, 0, "ID3") && view.byteLength >= 10
            ? 10 + ((view.getUint8(6) & 0x7f) << 21 | (view.getUint8(7) & 0x7f) << 14
            | (view.getUint8(8) & 0x7f) << 7 | (view.getUint8(9) & 0x7f))
            : 0
        if (start + 4 > view.byteLength) {return Option.None}
        const header = view.getUint32(start)
        const mpeg1Layer3 = (header >>> 21) === 0x7ff && ((header >>> 19) & 0x03) === 0x03 && ((header >>> 17) & 0x03) === 0x01
        if (!mpeg1Layer3) {return Option.None}
        const bitrate = Mp3Bitrates[(header >>> 12) & 0x0f]
        const sampleRate = Mp3SampleRates[(header >>> 10) & 0x03]
        if (!isDefined(bitrate) || bitrate === 0 || !isDefined(sampleRate)) {return Option.None}
        const channels = ((header >>> 6) & 0x03) === 0x03 ? 1 : 2
        const seconds = (fileSize - start) * 8 / (bitrate * 1000)
        return Option.wrap({frames: seconds * sampleRate, channels, sampleRate, bytesPerSample: 4, resampled: true, exact: false})
    }

    export const of = (header: ArrayBuffer, fileSize: number, decodeRate: number, smallest: boolean): Estimate => {
        const view = new DataView(header)
        const parsers: ReadonlyArray<Provider<Option<Shape>>> =
            [() => wav(view, smallest), () => aiff(view), () => flac(view), () => mp3(view, fileSize)]
        return parsers.reduce<Option<Shape>>((found, parse) => found.nonEmpty() ? found : parse(), Option.None).match({
            none: () => ({
                bytes: WavHeaderBytes + Math.round(fileSize / FallbackBytesPerSecond * decodeRate) * 2 * 4,
                exact: false
            }),
            some: ({frames, channels, sampleRate, bytesPerSample, resampled, exact}) => ({
                bytes: WavHeaderBytes + (resampled ? Math.round(frames * decodeRate / sampleRate) : frames) * channels * bytesPerSample,
                exact
            })
        })
    }
}
