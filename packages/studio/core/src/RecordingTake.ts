import {
    Exec,
    int,
    Notifier,
    Observer,
    Option,
    panic,
    RuntimeNotifier,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Peaks} from "@opendaw/lib-fusion"
import {Promises} from "@opendaw/lib-runtime"
import {mergeChunkPlanes, SampleLoader, SampleLoaderState, SampleMetaData} from "@opendaw/studio-adapters"
import {RenderQuantum} from "./RenderQuantum"
import {PeaksWriter} from "./PeaksWriter"
import {SampleService, SampleStorage} from "./samples"

// the ring delivers whole chunks, so the capture overshoots the limit: keep the head, drop the tail
export const recordedFrames = (chunks: ReadonlyArray<ReadonlyArray<Float32Array>>,
                               numFrames: int): ReadonlyArray<Float32Array> =>
    mergeChunkPlanes(chunks.slice(0, Math.ceil(numFrames / RenderQuantum)), RenderQuantum, numFrames)

// What RecordAudio needs from a recording in progress
export interface RecordingSource extends Terminable {
    readonly uuid: UUID.Bytes
    readonly numberOfFrames: int
    readonly firstQuantumTime: Option<number>
    set onSaved(callback: Exec)
    limit(count: int): void
    setFillLength(value: int): void
}

// A recording fed with render-quantum chunks: collects them, draws peaks, and saves the sample once limited.
// RecordingWorklet feeds it from its ring, the desktop app from the native engine.
export class RecordingTake implements RecordingSource, SampleLoader {
    readonly #terminator: Terminator = new Terminator()
    readonly #output: Array<ReadonlyArray<Float32Array>> = []
    readonly #notifier: Notifier<SampleLoaderState> = new Notifier<SampleLoaderState>()
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

    constructor(readonly uuid: UUID.Bytes, readonly sampleRate: number, readonly numberOfChannels: int, readonly stop: Exec) {
        this.#peakWriter = new PeaksWriter(numberOfChannels)
        this.#peaks = Option.wrap(this.#peakWriter)
    }

    append(chunk: ReadonlyArray<Float32Array>): void {
        if (!this.#isRecording) {return}
        this.#output.push(chunk)
        this.#peakWriter.append(chunk)
        if (this.numberOfFrames >= this.#limitSamples) {
            void this.#finalize()
        }
    }

    firstQuantum(contextTime: number): void {this.#firstQuantumTime = Option.wrap(contextTime)}

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
        this.stop()
        this.#isRecording = false
        this.#terminator.terminate()
    }

    async #finalize(): Promise<void> {
        this.#isRecording = false
        this.stop()
        if (this.#output.length === 0) {return panic("No recording data available")}
        const totalSamples: int = this.#limitSamples
        const mergedFrames = recordedFrames(this.#output, totalSamples)
        const audioData = AudioData.create(this.sampleRate, totalSamples, this.numberOfChannels)
        mergedFrames.forEach((frame, index) => audioData.frames[index].set(frame))
        this.#data = Option.wrap(audioData)
        const bpm = this.#bpm.unwrapOrElse(120)
        const imported = await Promises.tryCatch(this.#sampleService
            .unwrap("SampleService not set")
            .importRecording(this.uuid, audioData, bpm))
        if (imported.status === "resolved") {
            this.#peaks = Option.wrap(await SampleStorage.get().loadPeaks(this.uuid, audioData))
            this.#meta = Option.wrap(imported.value)
        } else {
            const {sampleRate} = this
            this.#meta = Option.wrap({
                name: "Recording", bpm, duration: totalSamples / sampleRate, sample_rate: sampleRate, origin: "recording"
            })
            RuntimeNotifier.info({
                headline: "Storage Unavailable",
                message: `The recording could not be saved to local storage (${String(imported.error)}). It stays playable until you close the tab.`
            }).finally()
        }
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
