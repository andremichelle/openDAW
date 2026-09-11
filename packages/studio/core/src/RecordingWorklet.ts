import {
    int,
    Notifier,
    Observer,
    Option,
    panic,
    Procedure,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Peaks} from "@opendaw/lib-fusion"
import {mergeChunkPlanes, RingBuffer, SampleLoader, SampleLoaderState, SampleMetaData} from "@opendaw/studio-adapters"
import {RenderQuantum} from "./RenderQuantum"
import {PeaksWriter} from "./PeaksWriter"
import {SampleService} from "./samples"

/**
 * The first `numFrames` frames of the recorded chunks, as one plane per channel. The ring delivers
 * whole chunks, so the recording can run past the frame count the takes reference: the HEAD is kept
 * (regions address the buffer from frame 0 through `waveformOffset`) and the overshoot is dropped
 * at the tail. `numFrames` must not exceed the frames the chunks hold.
 */
export const recordedFrames = (chunks: ReadonlyArray<ReadonlyArray<Float32Array>>,
                               numFrames: int): ReadonlyArray<Float32Array> =>
    mergeChunkPlanes(chunks.slice(0, Math.ceil(numFrames / RenderQuantum)), RenderQuantum, numFrames)

export class RecordingWorklet extends AudioWorkletNode implements Terminable, SampleLoader {
    readonly #terminator: Terminator = new Terminator()

    readonly uuid: UUID.Bytes = UUID.generate()

    readonly #output: Array<ReadonlyArray<Float32Array>>
    readonly #notifier: Notifier<SampleLoaderState>
    readonly #reader: RingBuffer.Reader
    readonly #peakWriter: PeaksWriter

    #data: Option<AudioData> = Option.None
    #peaks: Option<Peaks> = Option.None
    #firstQuantumTime: Option<number> = Option.None
    #isRecording: boolean = true
    #limitSamples: int = Number.POSITIVE_INFINITY
    #state: SampleLoaderState = {type: "record"}
    #onSaved: Option<Procedure<UUID.Bytes>> = Option.None
    #sampleService: Option<SampleService> = Option.None
    #bpm: Option<number> = Option.None

    constructor(context: BaseAudioContext, config: RingBuffer.Config) {
        super(context, "recording-processor", {
            numberOfInputs: 1,
            channelCount: config.numberOfChannels,
            channelCountMode: "explicit",
            processorOptions: config
        })

        this.#peakWriter = new PeaksWriter(config.numberOfChannels)
        this.#peaks = Option.wrap(this.#peakWriter)
        this.port.addEventListener("message", ({data}: MessageEvent) => {
            if (data?.type === "first-quantum" && typeof data.contextTime === "number") {
                this.#firstQuantumTime = Option.wrap(data.contextTime)
            }
        })
        this.port.start()
        this.#output = []
        this.#notifier = new Notifier<SampleLoaderState>()
        this.#reader = RingBuffer.reader(config, array => {
            if (this.#isRecording) {
                this.#output.push(array)
                this.#peakWriter.append(array)
                if (this.numberOfFrames >= this.#limitSamples) {
                    this.#finalize().catch(error => console.warn(error))
                }
            }
        })
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own(terminable)}

    limit(count: int): void {
        this.#limitSamples = count
        if (this.numberOfFrames >= this.#limitSamples) {
            this.#finalize().catch(error => console.warn(error))
        }
    }

    set onSaved(callback: Procedure<UUID.Bytes>) {this.#onSaved = Option.wrap(callback)}
    set bpm(value: number) {this.#bpm = Option.wrap(value)}
    set sampleService(service: SampleService) {this.#sampleService = Option.wrap(service)}

    setFillLength(value: int): void {this.#peakWriter.numFrames = value}

    get numberOfFrames(): int {return this.#output.length * RenderQuantum}
    /**
     * Context time of the buffer's first frame, reported by the processor from the audio thread.
     * Empty until the announcement arrives over the port. Frame `(t - firstQuantumTime) * sampleRate`
     * of the buffer was captured at context time `t`; `numberOfFrames` cannot say that, because it
     * counts chunks as the ring reader delivers them.
     */
    get firstQuantumTime(): Option<number> {return this.#firstQuantumTime}
    // A take in progress is not a stored sample yet, so it has no metadata to report. It acquires some when
    // `#save` hands it to `SampleService.importRecording`, and from then on a `DefaultSampleLoader` serves it.
    get meta(): Option<SampleMetaData> {return Option.None}
    get data(): Option<AudioData> {return this.#data}
    get peaks(): Option<Peaks> {return this.#peaks.isEmpty() ? Option.wrap(this.#peakWriter) : this.#peaks}
    get state(): SampleLoaderState {return this.#state}

    invalidate(): void {}

    subscribe(observer: Observer<SampleLoaderState>): Subscription {
        if (this.#state.type === "loaded") {
            observer(this.#state)
            return Terminable.Empty
        }
        return this.#notifier.subscribe(observer)
    }

    terminate(): void {
        this.#reader.stop()
        this.#isRecording = false
        this.#terminator.terminate()
    }

    toString(): string {return `{RecordingWorklet}`}

    async #finalize(): Promise<void> {
        this.#isRecording = false
        this.#reader.stop()
        if (this.#output.length === 0) {return panic("No recording data available")}
        const totalSamples: int = this.#limitSamples
        const mergedFrames = recordedFrames(this.#output, totalSamples)
        const audioData = AudioData.create(this.context.sampleRate, totalSamples, this.channelCount)
        mergedFrames.forEach((frame, index) => audioData.frames[index].set(frame))
        this.#data = Option.wrap(audioData)
        const sample = await this.#sampleService
            .unwrap("SampleService not set")
            .importRecording(audioData, this.#bpm.unwrapOrElse(120))
        this.#onSaved.ifSome(callback => callback(UUID.parse(sample.uuid)))
        this.#setState({type: "loaded"})
        this.terminate()
    }

    #setState(value: SampleLoaderState): void {
        this.#state = value
        this.#notifier.notify(this.#state)
    }
}