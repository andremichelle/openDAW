import {Exec, int, Observer, Option, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Peaks} from "@opendaw/lib-fusion"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {
    RecordingProcessorChannel,
    RecordingProcessorToClient,
    RingBuffer,
    SampleLoader,
    SampleLoaderState,
    SampleMetaData
} from "@opendaw/studio-adapters"
import {RecordingSource, RecordingTake} from "./RecordingTake"
import {SampleService} from "./samples"

export {recordedFrames} from "./RecordingTake"

export class RecordingWorklet extends AudioWorkletNode implements Terminable, SampleLoader, RecordingSource {
    readonly #terminator: Terminator = new Terminator()
    readonly #take: RecordingTake
    readonly #reader: RingBuffer.Reader

    readonly uuid: UUID.Bytes

    constructor(context: BaseAudioContext, uuid: UUID.Bytes, config: RingBuffer.Config) {
        super(context, "recording-processor", {
            numberOfInputs: 1,
            channelCount: config.numberOfChannels,
            channelCountMode: "explicit",
            processorOptions: config
        })

        this.uuid = uuid
        this.#take = new RecordingTake(uuid, context.sampleRate, this.channelCount, () => {
            this.#reader.stop()
            this.#terminator.terminate()
        })
        this.#terminator.own(Communicator.executor<RecordingProcessorToClient>(
            Messenger.for(this.port).channel(RecordingProcessorChannel), {
                firstQuantum: (contextTime: number): void => this.#take.firstQuantum(contextTime)
            }))
        this.#reader = RingBuffer.reader(config, array => this.#take.append(array))
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own(terminable)}

    limit(count: int): void {this.#take.limit(count)}

    set onSaved(callback: Exec) {this.#take.onSaved = callback}
    set bpm(value: number) {this.#take.bpm = value}
    set sampleService(service: SampleService) {this.#take.sampleService = service}

    setFillLength(value: int): void {this.#take.setFillLength(value)}

    get numberOfFrames(): int {return this.#take.numberOfFrames}
    get firstQuantumTime(): Option<number> {return this.#take.firstQuantumTime}
    get meta(): Option<SampleMetaData> {return this.#take.meta}
    get data(): Option<AudioData> {return this.#take.data}
    get peaks(): Option<Peaks> {return this.#take.peaks}
    get state(): SampleLoaderState {return this.#take.state}

    invalidate(): void {}

    subscribe(observer: Observer<SampleLoaderState>): Subscription {return this.#take.subscribe(observer)}

    terminate(): void {this.#take.terminate()}

    toString(): string {return `{RecordingWorklet}`}
}
