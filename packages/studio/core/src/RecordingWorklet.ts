import {
    int,
    Notifier,
    Observer,
    Option,
    panic,
    Exec,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Peaks} from "@opendaw/lib-fusion"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {
    mergeChunkPlanes,
    RecordingProcessorChannel,
    RecordingProcessorToClient,
    RingBuffer,
    SampleLoader,
    SampleLoaderState,
    SampleMetaData
} from "@opendaw/studio-adapters"
import {RenderQuantum} from "./RenderQuantum"
import {PeaksWriter} from "./PeaksWriter"
import {SampleService, SampleStorage} from "./samples"

// the ring delivers whole chunks, so the capture overshoots the limit: keep the head, drop the tail
export const recordedFrames = (chunks: ReadonlyArray<ReadonlyArray<Float32Array>>,
                               numFrames: int): ReadonlyArray<Float32Array> =>
    mergeChunkPlanes(chunks.slice(0, Math.ceil(numFrames / RenderQuantum)), RenderQuantum, numFrames)

export class RecordingWorklet extends AudioWorkletNode implements Terminable, SampleLoader {
    readonly #terminator: Terminator = new Terminator()

    readonly uuid: UUID.Bytes

    readonly #output: Array<ReadonlyArray<Float32Array>>
    readonly #notifier: Notifier<SampleLoaderState>
    readonly #reader: RingBuffer.Reader
    readonly #peakWriter: PeaksWriter

    #data: Option<AudioData> = Option.None
    #peaks: Option<Peaks> = Option.None
    #meta: Option<SampleMetaData> = Option.None
    #firstQuantumTime: Option<number> = Option.None
    #isRecording: boolean = true
    #limitSamples: int = Number.POSITIVE_INFINITY
    #state: SampleLoaderState = {type: "record"}
    #onSaved: Option<Exec> = Option.None
    #sampleService: Option<SampleService> = Option.None
    #bpm: Option<number> = Option.None

    constructor(context: BaseAudioContext, uuid: UUID.Bytes, config: RingBuffer.Config) {
        super(context, "recording-processor", {
            numberOfInputs: 1,
            channelCount: config.numberOfChannels,
            channelCountMode: "explicit",
            processorOptions: config
        })

        this.uuid = uuid
        this.#peakWriter = new PeaksWriter(config.numberOfChannels)
        this.#peaks = Option.wrap(this.#peakWriter)
        this.#terminator.own(Communicator.executor<RecordingProcessorToClient>(
            Messenger.for(this.port).channel(RecordingProcessorChannel), {
                firstQuantum: (contextTime: number): void => {this.#firstQuantumTime = Option.wrap(contextTime)}
            }))
        this.#output = []
        this.#notifier = new Notifier<SampleLoaderState>()
        this.#reader = RingBuffer.reader(config, array => {
            if (this.#isRecording) {
                this.#output.push(array)
                this.#peakWriter.append(array)
                if (this.numberOfFrames >= this.#limitSamples) {
                    void this.#finalize()
                }
            }
        })
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own(terminable)}

    limit(count: int): void {
        if (!this.#isRecording) {return}
        this.#limitSamples = count
        if (this.numberOfFrames >= this.#limitSamples) {
            void this.#finalize()
        }
    }

    set onSaved(callback: Exec) {this.#onSaved = Option.wrap(callback)}
    set bpm(value: number) {this.#bpm = Option.wrap(value)}
    set sampleService(service: SampleService) {this.#sampleService = Option.wrap(service)}

    setFillLength(value: int): void {this.#peakWriter.numFrames = value}

    get numberOfFrames(): int {return this.#output.length * RenderQuantum}
    get firstQuantumTime(): Option<number> {return this.#firstQuantumTime}
    get meta(): Option<SampleMetaData> {return this.#meta}
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
            .importRecording(this.uuid, audioData, this.#bpm.unwrapOrElse(120))
        this.#peaks = Option.wrap(await SampleStorage.get().loadPeaks(this.uuid, audioData))
        this.#meta = Option.wrap(sample)
        this.#output.length = 0
        this.#onSaved.ifSome(callback => callback())
        this.#setState({type: "loaded"})
        this.terminate()
    }

    #setState(value: SampleLoaderState): void {
        this.#state = value
        this.#notifier.notify(this.#state)
    }
}