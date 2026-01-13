import {asDefined, DefaultObservableValue, ObservableValue} from "@moises-ai/lib-std"
import type {
    AudioSample as AudioSampleClass,
    AudioSampleSource,
    BufferTarget,
    CanvasSource,
    Mp4OutputFormat,
    Output
} from "mediabunny"
import type {VideoExportConfig, VideoExporter} from "./VideoExporter"

type MediabunnyState = {
    output: Output<Mp4OutputFormat, BufferTarget>
    videoSource: CanvasSource
    audioSource: AudioSampleSource
    AudioSample: typeof AudioSampleClass
    ctx: OffscreenCanvasRenderingContext2D
}

export class WebCodecsVideoExporter implements VideoExporter {
    static isSupported(): boolean {
        return typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined"
    }

    static async create(config: VideoExportConfig): Promise<WebCodecsVideoExporter> {
        const {
            Output,
            Mp4OutputFormat,
            BufferTarget,
            CanvasSource,
            AudioSampleSource,
            AudioSample
        } = await import("mediabunny")
        const canvas = new OffscreenCanvas(config.width, config.height)
        const context = canvas.getContext("2d")!
        const output = new Output({
            format: new Mp4OutputFormat(),
            target: new BufferTarget()
        })
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
        return new WebCodecsVideoExporter(config, {output, videoSource, audioSource, AudioSample, ctx: context})
    }

    readonly #config: VideoExportConfig
    readonly #output: Output<Mp4OutputFormat, BufferTarget>
    readonly #videoSource: CanvasSource
    readonly #audioSource: AudioSampleSource
    readonly #AudioSample: typeof AudioSampleClass
    readonly #ctx: OffscreenCanvasRenderingContext2D
    readonly #progress: DefaultObservableValue<number> = new DefaultObservableValue(0)

    private constructor(config: VideoExportConfig, media: MediabunnyState) {
        this.#config = config
        this.#output = media.output
        this.#videoSource = media.videoSource
        this.#audioSource = media.audioSource
        this.#AudioSample = media.AudioSample
        this.#ctx = media.ctx
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

    async finalize(): Promise<Uint8Array> {
        await this.#output.finalize()
        this.#progress.setValue(1)
        return new Uint8Array(asDefined(this.#output.target.buffer))
    }

    terminate(): void {}
}
