import {asDefined, DefaultObservableValue, ObservableValue} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import type {
    AudioSample as AudioSampleClass,
    AudioSampleSource,
    BufferTarget,
    CanvasSource,
    Mp4OutputFormat,
    Output,
    Target
} from "mediabunny"
import type {VideoExportConfig, VideoExporter} from "./VideoExporter"

type EncoderState = {
    output: Output<Mp4OutputFormat, Target>
    videoSource: CanvasSource
    audioSource: AudioSampleSource
    AudioSample: typeof AudioSampleClass
    ctx: OffscreenCanvasRenderingContext2D
}

export abstract class WebCodecsVideoExporter implements VideoExporter {
    static isSupported(): boolean {
        return typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined"
    }

    protected static async createEncoder(config: VideoExportConfig, target: Target): Promise<EncoderState> {
        const {Output, Mp4OutputFormat, CanvasSource, AudioSampleSource, AudioSample} = await import("mediabunny")
        const canvas = new OffscreenCanvas(config.width, config.height)
        const ctx = asDefined(canvas.getContext("2d"))
        const output = new Output({format: new Mp4OutputFormat(), target})
        const videoSource = new CanvasSource(canvas, {
            codec: "avc",
            bitrate: config.videoBitrate ?? 5_000_000,
            bitrateMode: "constant",
            keyFrameInterval: 2
        })
        output.addVideoTrack(videoSource)
        const audioSource = new AudioSampleSource({
            codec: "opus",
            bitrate: config.audioBitrate ?? 192_000
        })
        output.addAudioTrack(audioSource)
        await output.start()
        return {output, videoSource, audioSource, AudioSample, ctx}
    }

    readonly #config: VideoExportConfig
    readonly #output: Output<Mp4OutputFormat, Target>
    readonly #videoSource: CanvasSource
    readonly #audioSource: AudioSampleSource
    readonly #AudioSample: typeof AudioSampleClass
    readonly #ctx: OffscreenCanvasRenderingContext2D
    readonly #progress: DefaultObservableValue<number> = new DefaultObservableValue(0)

    protected constructor(config: VideoExportConfig, encoder: EncoderState) {
        this.#config = config
        this.#output = encoder.output
        this.#videoSource = encoder.videoSource
        this.#audioSource = encoder.audioSource
        this.#AudioSample = encoder.AudioSample
        this.#ctx = encoder.ctx
    }

    get progress(): ObservableValue<number> {return this.#progress}

    async addFrame(canvas: OffscreenCanvas, audio: Float32Array[], timestampSeconds: number): Promise<void> {
        this.#ctx.drawImage(canvas, 0, 0)
        const frameDuration = 1 / this.#config.frameRate
        await this.#videoSource.add(timestampSeconds, frameDuration)
        if (audio.length > 0 && audio[0].length > 0) {
            const numberOfChannels = audio.length
            const numberOfFrames = audio[0].length
            const timestampUs = Math.round(timestampSeconds * 1_000_000)
            const audioBuffer = new Float32Array(numberOfChannels * numberOfFrames)
            for (let channel = 0; channel < numberOfChannels; channel++) {
                audioBuffer.set(audio[channel], channel * numberOfFrames)
            }
            const audioData = new AudioData({
                format: "f32-planar",
                sampleRate: this.#config.sampleRate,
                numberOfFrames,
                numberOfChannels,
                timestamp: timestampUs,
                data: audioBuffer
            })
            const audioSample = new this.#AudioSample(audioData)
            await this.#audioSource.add(audioSample)
            audioSample.close()
            audioData.close()
        }
    }

    protected async finalizeOutput(): Promise<void> {
        await this.#output.finalize()
        this.#progress.setValue(1)
    }

    abstract finalize(): Promise<void>
    abstract abort(): Promise<void>
    terminate(): void {}
}

export class StreamVideoExporter extends WebCodecsVideoExporter {
    static async create(config: VideoExportConfig, writable: WritableStream): Promise<StreamVideoExporter> {
        const {StreamTarget} = await import("mediabunny")
        const encoder = await WebCodecsVideoExporter.createEncoder(config, new StreamTarget(writable, {chunked: true}))
        return new StreamVideoExporter(config, encoder, writable)
    }

    readonly #writable: WritableStream

    private constructor(config: VideoExportConfig, encoder: EncoderState, writable: WritableStream) {
        super(config, encoder)
        this.#writable = writable
    }

    async finalize(): Promise<void> {
        await this.finalizeOutput()
    }

    async abort(): Promise<void> {
        await Promises.tryCatch(this.#writable.abort())
    }
}

export class BufferVideoExporter extends WebCodecsVideoExporter {
    static async create(config: VideoExportConfig): Promise<BufferVideoExporter> {
        const {BufferTarget} = await import("mediabunny")
        const bufferTarget = new BufferTarget()
        const encoder = await WebCodecsVideoExporter.createEncoder(config, bufferTarget)
        return new BufferVideoExporter(config, encoder, bufferTarget)
    }

    readonly #bufferTarget: BufferTarget

    private constructor(config: VideoExportConfig, encoder: EncoderState, bufferTarget: BufferTarget) {
        super(config, encoder)
        this.#bufferTarget = bufferTarget
    }

    async finalize(): Promise<void> {
        await this.finalizeOutput()
        await Files.save(asDefined(this.#bufferTarget.buffer), {suggestedName: "opendaw-video.mp4"})
    }

    async abort(): Promise<void> {}
}
