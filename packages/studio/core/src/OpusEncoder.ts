import {asDefined, assert, EmptyExec, Errors, int, isDefined, Optional, Progress, Terminable, TimeSpan} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Events} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"

export namespace OpusEncoder {
    export type Application = "audio" | "voip" | "lowdelay"

    export type Settings = Readonly<{
        numberOfChannels: int
        bitrate: int
        complexity: int
        frameDuration: int
        variable: boolean
        application: Application
    }>

    export const SampleRate = 48_000

    type Signal = "auto" | "music" | "voice"

    type Config = OpusEncoderConfig & { application?: Application, signal?: Signal }

    type EncodedChunk = [EncodedAudioChunk, Optional<EncodedAudioChunkMetadata>]

    const BlockSize = 48_000

    // every queued block holds its own copy of the audio until the encoder takes it
    const MaxQueuedBlocks = 4

    const DequeueFallback = TimeSpan.millis(50)

    const config = (settings: Settings, numberOfChannels: int): AudioEncoderConfig => {
        const {application, complexity, frameDuration, bitrate, variable} = settings
        const opus: Config = {
            format: "opus", complexity, frameDuration, application,
            signal: application === "audio" ? "music" : application === "voip" ? "voice" : "auto"
        }
        return {
            codec: "opus",
            sampleRate: SampleRate,
            numberOfChannels,
            bitrate: bitrate * 1000,
            bitrateMode: variable ? "variable" : "constant",
            opus
        }
    }

    export const isSupported = async (settings: Settings): Promise<boolean> => {
        if (typeof AudioEncoder === "undefined") {return false}
        const {status, value} = await Promises.tryCatch(AudioEncoder.isConfigSupported(config(settings, 2)))
        return status === "resolved" && value.supported === true
    }

    export const encode = async (audio: AudioData, settings: Settings, progress: Progress.Handler = Progress.Empty,
                                 abortSignal?: AbortSignal): Promise<ArrayBuffer> => {
        assert(audio.sampleRate === SampleRate, () => `Opus encodes ${SampleRate} Hz audio, got ${audio.sampleRate} Hz`)
        if (abortSignal?.aborted === true) {return Promise.reject(Errors.AbortError)}
        const mapped = toChannels(audio, settings.numberOfChannels)
        const {Output, OggOutputFormat, BufferTarget, EncodedAudioPacketSource, EncodedPacket} =
            await Promises.guardedRetry(() => import("mediabunny"), (_, count) => count < 60)
        const {promise: failure, reject} = Promise.withResolvers<never>()
        failure.catch(EmptyExec)
        const chunks: Array<EncodedChunk> = []
        const encoder = new AudioEncoder({output: (chunk, meta) => chunks.push([chunk, meta]), error: error => reject(error)})
        const abort = isDefined(abortSignal)
            ? Events.subscribeAny(abortSignal, "abort", () => reject(Errors.AbortError), {once: true})
            : Terminable.Empty
        encoder.configure(config(settings, mapped.numberOfChannels))
        return feed(encoder, mapped, progress, failure)
            .then(async () => {
                if (abortSignal?.aborted === true) {return Promise.reject(Errors.AbortError)}
                const target = new BufferTarget()
                const output = new Output({format: new OggOutputFormat(), target})
                const source = new EncodedAudioPacketSource("opus")
                output.addAudioTrack(source)
                await output.start()
                for (const [chunk, meta] of chunks) {await source.add(EncodedPacket.fromEncodedChunk(chunk), meta)}
                await output.finalize()
                progress(1.0)
                return asDefined(target.buffer, "Ogg output buffer")
            })
            .finally(() => {
                abort.terminate()
                if (encoder.state !== "closed") {encoder.close()}
            })
    }

    const feed = async (encoder: AudioEncoder, audio: AudioData, progress: Progress.Handler,
                        failure: Promise<never>): Promise<void> => {
        const {numberOfFrames, numberOfChannels, frames} = audio
        for (let position = 0; position < numberOfFrames; position += BlockSize) {
            while (encoder.encodeQueueSize >= MaxQueuedBlocks) {await Promise.race([dequeued(encoder), failure])}
            const length = Math.min(BlockSize, numberOfFrames - position)
            const planar = new Float32Array(length * numberOfChannels)
            for (let channel = 0; channel < numberOfChannels; channel++) {
                planar.set(frames[channel].subarray(position, position + length), channel * length)
            }
            const block = new globalThis.AudioData({
                format: "f32-planar", sampleRate: SampleRate, numberOfFrames: length, numberOfChannels,
                timestamp: Math.round(position / SampleRate * 1_000_000), data: planar
            })
            encoder.encode(block)
            block.close()
            progress(0.9 * (position + length) / numberOfFrames)
        }
        const flushed = encoder.flush()
        flushed.catch(EmptyExec)
        await Promise.race([flushed, failure])
    }

    const dequeued = (encoder: AudioEncoder): Promise<void> => {
        const {promise, resolve} = Promise.withResolvers<void>()
        const subscription = Events.subscribeAny(encoder, "dequeue", () => resolve(), {once: true})
        const timeout = setTimeout(resolve, DequeueFallback.millis())
        return promise.finally(() => {
            subscription.terminate()
            clearTimeout(timeout)
        })
    }

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
}
