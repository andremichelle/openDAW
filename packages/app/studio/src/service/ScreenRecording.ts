import {asDefined, EmptyExec, Func, int, isDefined, Nullable, Option, Optional, Procedure, Terminable} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import type {
    AudioCodec, EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Output, VideoCodec
} from "mediabunny"

const KeyFrameInterval = 2_000_000 // microseconds
const BitsPerPixel = 0.08

type Candidate<C> = { codec: C, codecString: string }

const VideoCandidates: ReadonlyArray<Candidate<VideoCodec>> = [
    {codec: "avc", codecString: "avc1.640034"},
    {codec: "hevc", codecString: "hvc1.1.6.L156.B0"},
    {codec: "vp9", codecString: "vp09.00.51.08"},
    {codec: "av1", codecString: "av01.0.13M.08"}
]

const AudioCandidates: ReadonlyArray<Candidate<AudioCodec>> = [
    {codec: "aac", codecString: "mp4a.40.2"},
    {codec: "opus", codecString: "opus"}
]

const firstSupported = async <C, T>(candidates: ReadonlyArray<Candidate<C>>,
                                    create: Func<string, T>,
                                    check: Func<T, Promise<VideoEncoderSupport | AudioEncoderSupport>>): Promise<Option<[C, T]>> => {
    for (const {codec, codecString} of candidates) {
        const config = create(codecString)
        const {status, value} = await Promises.tryCatch(check(config))
        if (status === "resolved" && value.supported === true) {return Option.wrap([codec, config])}
    }
    return Option.None
}

type Muxing = {
    output: Output
    Packet: typeof EncodedPacket
    videoSource: EncodedVideoPacketSource
    audioSource: EncodedAudioPacketSource
    origin: number
    videoFrom: Nullable<number>
    videoOffset: number
    audioOffset: Nullable<number>
    videoChain: Promise<void>
    audioChain: Promise<void>
    decoderConfigSent: boolean
}

export namespace ScreenRecording {
    export type Codecs = {
        video: VideoCodec
        videoConfig: VideoEncoderConfig
        audio: AudioCodec
        audioConfig: AudioEncoderConfig
    }
}

export class ScreenRecording implements Terminable {
    static async selectCodecs(width: int, height: int, frameRate: number, sampleRate: number): Promise<Option<ScreenRecording.Codecs>> {
        const bitrate = Math.round(width * height * frameRate * BitsPerPixel)
        const video = await firstSupported(VideoCandidates, (codec): VideoEncoderConfig =>
                codec.startsWith("avc1")
                    ? {codec, width, height, bitrate, framerate: frameRate, avc: {format: "avc"}}
                    : {codec, width, height, bitrate, framerate: frameRate},
            config => VideoEncoder.isConfigSupported(config))
        const audio = await firstSupported(AudioCandidates, (codec): AudioEncoderConfig =>
                ({codec, sampleRate, numberOfChannels: 2, bitrate: 256_000}),
            config => AudioEncoder.isConfigSupported(config))
        if (video.isEmpty() || audio.isEmpty()) {return Option.None}
        const [videoCodec, videoConfig] = video.unwrap()
        const [audioCodec, audioConfig] = audio.unwrap()
        return Option.wrap({video: videoCodec, videoConfig, audio: audioCodec, audioConfig})
    }

    readonly #codecs: ScreenRecording.Codecs
    readonly #audioTrack: MediaStreamAudioTrack
    readonly #onError: Procedure<unknown>
    readonly #videoEncoder: VideoEncoder
    readonly #audioEncoder: AudioEncoder
    readonly #videoReader: ReadableStreamDefaultReader<VideoFrame>

    #audioReader: Option<ReadableStreamDefaultReader<AudioData>> = Option.None
    #muxing: Option<Muxing> = Option.None
    #decoderConfig: Option<VideoDecoderConfig> = Option.None
    #canvas: Option<OffscreenCanvasRenderingContext2D> = Option.None
    #videoConfig: VideoEncoderConfig
    #lastKeyFrame: number = Number.NEGATIVE_INFINITY
    #failed: boolean = false

    constructor(videoTrack: MediaStreamVideoTrack,
                audioTrack: MediaStreamAudioTrack,
                codecs: ScreenRecording.Codecs,
                onError: Procedure<unknown>) {
        this.#codecs = codecs
        this.#videoConfig = codecs.videoConfig
        this.#audioTrack = audioTrack
        this.#onError = onError
        this.#videoEncoder = new VideoEncoder({
            output: (chunk, metadata) => this.#onVideoChunk(chunk, metadata),
            error: error => this.#fail(error)
        })
        this.#videoEncoder.configure(codecs.videoConfig)
        this.#audioEncoder = new AudioEncoder({
            output: (chunk, metadata) => this.#onAudioChunk(chunk, metadata),
            error: error => this.#fail(error)
        })
        this.#videoReader = new MediaStreamTrackProcessor({track: videoTrack}).readable.getReader()
        this.#pumpVideo().then()
    }

    async record(writable: WritableStream): Promise<void> {
        const {
            Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket
        } = await import("mediabunny")
        const output = new Output({format: new Mp4OutputFormat(), target: new StreamTarget(writable, {chunked: true})})
        const videoSource = new EncodedVideoPacketSource(this.#codecs.video)
        const audioSource = new EncodedAudioPacketSource(this.#codecs.audio)
        output.addVideoTrack(videoSource)
        output.addAudioTrack(audioSource)
        await output.start()
        this.#muxing = Option.wrap({
            output, Packet: EncodedPacket, videoSource, audioSource, origin: performance.now(),
            videoFrom: null, videoOffset: 0.0, audioOffset: null,
            videoChain: Promise.resolve(), audioChain: Promise.resolve(), decoderConfigSent: false
        })
        this.#audioEncoder.configure(this.#codecs.audioConfig)
        const audioReader = new MediaStreamTrackProcessor({track: this.#audioTrack}).readable.getReader()
        this.#audioReader = Option.wrap(audioReader)
        this.#pumpAudio(audioReader).then()
    }

    async finish(): Promise<void> {
        const muxing = this.#muxing.unwrap("Recording has not started")
        await Promises.tryCatch(this.#videoReader.cancel())
        await this.#audioReader.match({
            none: () => Promise.resolve(),
            some: reader => Promises.tryCatch(reader.cancel()).then(EmptyExec)
        })
        await this.#videoEncoder.flush()
        await this.#audioEncoder.flush()
        await muxing.videoChain
        await muxing.audioChain
        await muxing.output.finalize()
    }

    terminate(): void {
        this.#videoReader.cancel().catch(error => console.warn(error))
        this.#audioReader.ifSome(reader => reader.cancel().catch(error => console.warn(error)))
        if (this.#videoEncoder.state !== "closed") {this.#videoEncoder.close()}
        if (this.#audioEncoder.state !== "closed") {this.#audioEncoder.close()}
        this.#muxing.ifSome(({output}) => {
            if (output.state === "started") {output.cancel().catch(error => console.warn(error))}
        })
    }

    async #pumpVideo(): Promise<void> {
        let next = await Promises.tryCatch(this.#videoReader.read())
        while (next.status === "resolved" && !next.value.done) {
            const frame = next.value.value
            if (this.#videoEncoder.state === "configured") {
                if (this.#muxing.isEmpty()) {this.#followSize(frame)}
                const fitted = this.#fit(frame)
                this.#videoEncoder.encode(fitted, {keyFrame: this.#keyFrameDue(fitted.timestamp)})
                if (fitted !== frame) {fitted.close()}
            }
            frame.close()
            next = await Promises.tryCatch(this.#videoReader.read())
        }
    }

    async #pumpAudio(reader: ReadableStreamDefaultReader<AudioData>): Promise<void> {
        let next = await Promises.tryCatch(reader.read())
        while (next.status === "resolved" && !next.value.done) {
            const data = next.value.value
            this.#muxing.ifSome(muxing => {
                if (!isDefined(muxing.audioOffset)) {
                    muxing.audioOffset = (performance.now() - muxing.origin) / 1000 - data.timestamp / 1e6
                }
            })
            if (this.#audioEncoder.state === "configured") {this.#audioEncoder.encode(data)}
            data.close()
            next = await Promises.tryCatch(reader.read())
        }
    }

    #keyFrameDue(timestamp: number): boolean {
        const due = this.#muxing.match({
            none: () => false,
            some: muxing => {
                if (isDefined(muxing.videoFrom)) {return timestamp - this.#lastKeyFrame >= KeyFrameInterval}
                muxing.videoFrom = timestamp
                muxing.videoOffset = (performance.now() - muxing.origin) / 1000 - timestamp / 1e6
                return true
            }
        })
        if (due) {this.#lastKeyFrame = timestamp}
        return due
    }

    #followSize(frame: VideoFrame): void {
        const width = frame.displayWidth & ~1
        const height = frame.displayHeight & ~1
        if (width === this.#videoConfig.width && height === this.#videoConfig.height) {return}
        const {bitrate = 0} = this.#codecs.videoConfig
        const scale = (width * height) / (this.#codecs.videoConfig.width * this.#codecs.videoConfig.height)
        this.#videoConfig = {...this.#videoConfig, width, height, bitrate: Math.round(bitrate * scale)}
        this.#videoEncoder.configure(this.#videoConfig)
        this.#decoderConfig = Option.None
    }

    #fit(frame: VideoFrame): VideoFrame {
        const {width, height} = this.#videoConfig
        const {displayWidth, displayHeight} = frame
        if (displayWidth === width && displayHeight === height) {return frame}
        const context = this.#canvas.match({
            none: () => {
                const created = asDefined(new OffscreenCanvas(width, height).getContext("2d"), "No 2d context")
                this.#canvas = Option.wrap(created)
                return created
            },
            some: context => context
        })
        const scale = Math.min(width / displayWidth, height / displayHeight)
        const scaledWidth = displayWidth * scale
        const scaledHeight = displayHeight * scale
        context.fillStyle = "black"
        context.fillRect(0, 0, width, height)
        context.drawImage(frame, (width - scaledWidth) / 2, (height - scaledHeight) / 2, scaledWidth, scaledHeight)
        return new VideoFrame(context.canvas, {timestamp: frame.timestamp})
    }

    #onVideoChunk(chunk: EncodedVideoChunk, metadata: Optional<EncodedVideoChunkMetadata>): void {
        if (isDefined(metadata?.decoderConfig)) {this.#decoderConfig = Option.wrap(metadata.decoderConfig)}
        this.#muxing.ifSome(muxing => {
            if (!isDefined(muxing.videoFrom) || chunk.timestamp < muxing.videoFrom) {return}
            const packet = muxing.Packet.fromEncodedChunk(chunk)
            const timed = packet.clone({timestamp: packet.timestamp + muxing.videoOffset})
            const decoderConfig = muxing.decoderConfigSent ? undefined : this.#decoderConfig.unwrapOrUndefined()
            muxing.decoderConfigSent = true
            muxing.videoChain = muxing.videoChain.then(() => muxing.videoSource.add(timed, {decoderConfig}))
            muxing.videoChain.catch(error => this.#fail(error))
        })
    }

    #onAudioChunk(chunk: EncodedAudioChunk, metadata: Optional<EncodedAudioChunkMetadata>): void {
        this.#muxing.ifSome(muxing => {
            if (!isDefined(muxing.audioOffset)) {return}
            const offset = muxing.audioOffset
            const packet = muxing.Packet.fromEncodedChunk(chunk)
            const timed = packet.clone({timestamp: packet.timestamp + offset})
            muxing.audioChain = muxing.audioChain.then(() => muxing.audioSource.add(timed, metadata))
            muxing.audioChain.catch(error => this.#fail(error))
        })
    }

    #fail(error: unknown): void {
        if (this.#failed) {return}
        this.#failed = true
        this.#onError(error)
    }
}
