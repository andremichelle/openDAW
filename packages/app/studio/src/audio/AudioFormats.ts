import {
    asDefined,
    assert,
    DefaultObservableValue,
    Func,
    int,
    MutableObservableValue,
    ObservableValue,
    Optional,
    Progress,
    RuntimeNotifier
} from "@opendaw/lib-std"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import type {FFmpegWorker} from "@opendaw/studio-core"

export namespace AudioFormats {
    export type Choice<V> = Readonly<{ value: V, label: string }>

    export type ChoiceField<V> = Readonly<{
        type: "menu" | "radio"
        label: string
        model: MutableObservableValue<V>
        choices: ReadonlyArray<Choice<V>>
        visible?: ObservableValue<boolean>
    }>

    export type NumberField = Readonly<{
        type: "number"
        label: string
        model: MutableObservableValue<int>
        min: int
        max: int
        minLabel: string
        maxLabel: string
        visible?: ObservableValue<boolean>
    }>

    export type Field = ChoiceField<number> | ChoiceField<string> | ChoiceField<boolean> | NumberField

    export interface Format {
        readonly label: string
        readonly extension: string
        readonly description: string
        readonly requiresFFmpeg: boolean
        readonly columns: 1 | 2
        readonly fields: ReadonlyArray<Field>
        get sampleRate(): int
        isSupported(): Promise<boolean>
        encode(audio: AudioData): Promise<ArrayBuffer>
    }

    const channelsField = (model: MutableObservableValue<int>): Field => ({
        type: "radio", label: "Channels", model,
        choices: [{value: 1, label: "Mono"}, {value: 2, label: "Stereo"}]
    })

    const sampleRateField = (model: MutableObservableValue<int>, rates: ReadonlyArray<int>): Field => ({
        type: "menu", label: "Sample Rate", model,
        choices: rates.map(rate => ({value: rate, label: `${rate} Hz`}))
    })

    const toChannels = (audio: AudioData, numberOfChannels: int): AudioData => {
        if (audio.numberOfChannels === numberOfChannels) {return audio}
        assert(audio.numberOfChannels === 2 && numberOfChannels === 1,
            `Cannot map ${audio.numberOfChannels} to ${numberOfChannels} channels`)
        const result = AudioData.create(audio.sampleRate, audio.numberOfFrames, 1)
        const [left, right] = audio.frames
        const mono = result.frames[0]
        for (let index = 0; index < audio.numberOfFrames; index++) {
            mono[index] = (left[index] + right[index]) * 0.5
        }
        return result
    }

    const withProgress = async <T>(headline: string, task: Func<Progress.Handler, Promise<T>>): Promise<T> => {
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline, progress})
        return task(value => progress.setValue(value)).finally(() => dialog.terminate())
    }

    const loadFFmpeg = async (): Promise<FFmpegWorker> => {
        const {FFmpegWorker} = await Promises.guardedRetry(() =>
            import("@opendaw/studio-core/FFmpegWorker"), (_, count) => count < 60)
        const {status, value, error} = await Promises.tryCatch(
            withProgress("Loading FFmpeg...", progress => FFmpegWorker.load(progress)))
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load FFmpeg.", icon: "Warning"})
            throw error
        }
        return value
    }

    class WavFormat implements Format {
        readonly label = "WAV"
        readonly extension = "wav"
        readonly description = "Uncompressed PCM. 32 bit float is lossless, 16 and 24 bit are quantized."
        readonly requiresFFmpeg = false
        readonly columns = 1
        readonly fields: ReadonlyArray<Field>
        readonly #channels: DefaultObservableValue<int>
        readonly #sampleRate: DefaultObservableValue<int>
        readonly #bitDepth: DefaultObservableValue<int>

        constructor() {
            this.#channels = new DefaultObservableValue<int>(2)
            this.#sampleRate = new DefaultObservableValue<int>(48_000)
            this.#bitDepth = new DefaultObservableValue<int>(32)
            this.fields = [
                channelsField(this.#channels),
                sampleRateField(this.#sampleRate, [44_100, 48_000, 96_000]),
                {
                    type: "menu", label: "Bit Depth", model: this.#bitDepth,
                    choices: [{value: 16, label: "16 Bit"}, {value: 24, label: "24 Bit"}, {value: 32, label: "32 Bit Float"}]
                }
            ]
        }

        get sampleRate(): int {return this.#sampleRate.getValue()}

        async isSupported(): Promise<boolean> {return true}

        async encode(audio: AudioData): Promise<ArrayBuffer> {
            const mapped = toChannels(audio, this.#channels.getValue())
            switch (this.#bitDepth.getValue()) {
                case 16:
                    return WavFile.encodeInts16(mapped)
                case 24:
                    return WavFile.encodeInts24(mapped)
                default:
                    return WavFile.encodeFloats(mapped)
            }
        }
    }

    class FlacFormat implements Format {
        readonly label = "FLAC"
        readonly extension = "flac"
        readonly description = "Lossless compression of 16 or 24 bit PCM. About half the size of WAV."
        readonly requiresFFmpeg = true
        readonly columns = 1
        readonly fields: ReadonlyArray<Field>
        readonly #channels: DefaultObservableValue<int>
        readonly #sampleRate: DefaultObservableValue<int>
        readonly #bitDepth: DefaultObservableValue<int>
        readonly #compression: DefaultObservableValue<int>

        constructor() {
            this.#channels = new DefaultObservableValue<int>(2)
            this.#sampleRate = new DefaultObservableValue<int>(48_000)
            this.#bitDepth = new DefaultObservableValue<int>(24)
            this.#compression = new DefaultObservableValue<int>(8)
            this.fields = [
                channelsField(this.#channels),
                sampleRateField(this.#sampleRate, [44_100, 48_000, 96_000]),
                {
                    type: "menu", label: "Bit Depth", model: this.#bitDepth,
                    choices: [{value: 16, label: "16 Bit"}, {value: 24, label: "24 Bit"}]
                },
                {
                    type: "number", label: "Compression", model: this.#compression,
                    min: 0, max: 8, minLabel: "Fast", maxLabel: "Small"
                }
            ]
        }

        get sampleRate(): int {return this.#sampleRate.getValue()}

        async isSupported(): Promise<boolean> {return true}

        async encode(audio: AudioData): Promise<ArrayBuffer> {
            const mapped = toChannels(audio, this.#channels.getValue())
            const wav = this.#bitDepth.getValue() === 16 ? WavFile.encodeInts16(mapped) : WavFile.encodeInts24(mapped)
            const ffmpeg = await loadFFmpeg()
            return withProgress("Encoding FLAC...", progress => ffmpeg.flacConverter()
                .convert(new Blob([wav]), progress, {compression: this.#compression.getValue()}))
        }
    }

    class Mp3Format implements Format {
        readonly label = "MP3"
        readonly extension = "mp3"
        readonly description = "Lossy and universally supported."
        readonly requiresFFmpeg = true
        readonly columns = 1
        readonly fields: ReadonlyArray<Field>
        readonly #channels: DefaultObservableValue<int>
        readonly #sampleRate: DefaultObservableValue<int>
        readonly #variable: DefaultObservableValue<boolean>
        readonly #bitrate: DefaultObservableValue<int>
        readonly #quality: DefaultObservableValue<int>

        constructor() {
            this.#channels = new DefaultObservableValue<int>(2)
            this.#sampleRate = new DefaultObservableValue<int>(48_000)
            this.#variable = new DefaultObservableValue(false)
            this.#bitrate = new DefaultObservableValue<int>(320)
            this.#quality = new DefaultObservableValue<int>(2)
            this.fields = [
                channelsField(this.#channels),
                sampleRateField(this.#sampleRate, [44_100, 48_000]),
                {
                    type: "radio", label: "Mode", model: this.#variable,
                    choices: [{value: false, label: "Constant"}, {value: true, label: "Variable"}]
                },
                {
                    type: "menu", label: "Bit Rate", model: this.#bitrate,
                    choices: [128, 160, 192, 224, 256, 320].map(kbps => ({value: kbps, label: `${kbps} kbps`})),
                    visible: MutableObservableValue.inverseBoolean(this.#variable)
                },
                {
                    type: "number", label: "Quality", model: this.#quality,
                    min: 0, max: 9, minLabel: "Best", maxLabel: "Small", visible: this.#variable
                }
            ]
        }

        get sampleRate(): int {return this.#sampleRate.getValue()}

        async isSupported(): Promise<boolean> {return true}

        async encode(audio: AudioData): Promise<ArrayBuffer> {
            const wav = WavFile.encodeFloats(toChannels(audio, this.#channels.getValue()))
            const options = this.#variable.getValue()
                ? {quality: this.#quality.getValue()}
                : {bitrate: `${this.#bitrate.getValue()}k`}
            const ffmpeg = await loadFFmpeg()
            return withProgress("Encoding MP3...", progress => ffmpeg.mp3Converter()
                .convert(new Blob([wav]), progress, options))
        }
    }

    type OpusApplication = "audio" | "voip" | "lowdelay"

    type OpusSignal = "auto" | "music" | "voice"

    type OpusConfig = OpusEncoderConfig & { application?: OpusApplication, signal?: OpusSignal }

    class OpusFormat implements Format {
        static readonly SampleRate = 48_000
        static readonly BlockSize = 48_000

        readonly label = "Opus"
        readonly extension = "opus"
        readonly description = "Lossy with the best quality per bit rate. Smaller than MP3 at equal quality."
        readonly requiresFFmpeg = false
        readonly columns = 2
        readonly fields: ReadonlyArray<Field>
        readonly #channels: DefaultObservableValue<int>
        readonly #bitrate: DefaultObservableValue<int>
        readonly #complexity: DefaultObservableValue<int>
        readonly #frameDuration: DefaultObservableValue<int>
        readonly #variable: DefaultObservableValue<boolean>
        readonly #application: DefaultObservableValue<OpusApplication>

        constructor() {
            this.#channels = new DefaultObservableValue<int>(2)
            this.#bitrate = new DefaultObservableValue<int>(160)
            this.#complexity = new DefaultObservableValue<int>(10)
            this.#frameDuration = new DefaultObservableValue<int>(20_000)
            this.#variable = new DefaultObservableValue(true)
            this.#application = new DefaultObservableValue<OpusApplication>("audio")
            this.fields = [
                channelsField(this.#channels),
                {
                    type: "menu", label: "Bit Rate", model: this.#bitrate,
                    choices: [64, 96, 128, 160, 192, 256, 320, 510].map(kbps => ({value: kbps, label: `${kbps} kbps`}))
                },
                {
                    type: "number", label: "Complexity", model: this.#complexity,
                    min: 0, max: 10, minLabel: "Fast", maxLabel: "Best"
                },
                {
                    type: "menu", label: "Frame Duration", model: this.#frameDuration,
                    choices: [2_500, 5_000, 10_000, 20_000, 40_000, 60_000]
                        .map(micros => ({value: micros, label: `${micros / 1000} ms`}))
                },
                {
                    type: "radio", label: "VBR Mode", model: this.#variable,
                    choices: [{value: false, label: "Off"}, {value: true, label: "On"}]
                },
                {
                    type: "menu", label: "Optimize For", model: this.#application,
                    choices: [
                        {value: "audio", label: "Music"},
                        {value: "voip", label: "Voice"},
                        {value: "lowdelay", label: "Low Delay"}
                    ]
                }
            ]
        }

        get sampleRate(): int {return OpusFormat.SampleRate}

        async isSupported(): Promise<boolean> {
            if (typeof AudioEncoder === "undefined") {return false}
            const {status, value} = await Promises.tryCatch(AudioEncoder.isConfigSupported(this.#config(2)))
            return status === "resolved" && value.supported === true
        }

        async encode(audio: AudioData): Promise<ArrayBuffer> {
            const mapped = toChannels(audio, this.#channels.getValue())
            const {Output, OggOutputFormat, BufferTarget, EncodedAudioPacketSource, EncodedPacket} =
                await Promises.guardedRetry(() => import("mediabunny"), (_, count) => count < 60)
            return withProgress("Encoding Opus...", async progress => {
                const chunks: Array<[EncodedAudioChunk, Optional<EncodedAudioChunkMetadata>]> = []
                const {promise: failure, reject} = Promise.withResolvers<never>()
                const encoder = new AudioEncoder({
                    output: (chunk, meta) => chunks.push([chunk, meta]),
                    error: error => reject(error)
                })
                encoder.configure(this.#config(mapped.numberOfChannels))
                const {numberOfFrames, numberOfChannels, frames} = mapped
                for (let position = 0; position < numberOfFrames; position += OpusFormat.BlockSize) {
                    const length = Math.min(OpusFormat.BlockSize, numberOfFrames - position)
                    const planar = new Float32Array(length * numberOfChannels)
                    for (let channel = 0; channel < numberOfChannels; channel++) {
                        planar.set(frames[channel].subarray(position, position + length), channel * length)
                    }
                    const block = new globalThis.AudioData({
                        format: "f32-planar",
                        sampleRate: OpusFormat.SampleRate,
                        numberOfFrames: length,
                        numberOfChannels,
                        timestamp: Math.round(position / OpusFormat.SampleRate * 1_000_000),
                        data: planar
                    })
                    encoder.encode(block)
                    block.close()
                    progress(0.9 * (position + length) / numberOfFrames)
                }
                await Promise.race([encoder.flush(), failure])
                encoder.close()
                const target = new BufferTarget()
                const output = new Output({format: new OggOutputFormat(), target})
                const source = new EncodedAudioPacketSource("opus")
                output.addAudioTrack(source)
                await output.start()
                for (const [chunk, meta] of chunks) {
                    await source.add(EncodedPacket.fromEncodedChunk(chunk), meta)
                }
                await output.finalize()
                progress(1.0)
                return asDefined(target.buffer, "Ogg output buffer")
            })
        }

        #config(numberOfChannels: int): AudioEncoderConfig {
            const application = this.#application.getValue()
            const opus: OpusConfig = {
                format: "opus",
                complexity: this.#complexity.getValue(),
                frameDuration: this.#frameDuration.getValue(),
                application,
                signal: application === "audio" ? "music" : application === "voip" ? "voice" : "auto"
            }
            return {
                codec: "opus",
                sampleRate: OpusFormat.SampleRate,
                numberOfChannels,
                bitrate: this.#bitrate.getValue() * 1000,
                bitrateMode: this.#variable.getValue() ? "variable" : "constant",
                opus
            }
        }
    }

    export const All: ReadonlyArray<Format> = [new WavFormat(), new FlacFormat(), new Mp3Format(), new OpusFormat()]

    export const available = async (): Promise<ReadonlyArray<Format>> => {
        const supported = await Promise.all(All.map(format => format.isSupported()))
        return All.filter((_, index) => supported[index])
    }
}
