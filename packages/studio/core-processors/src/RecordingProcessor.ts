import {int, Option} from "@opendaw/lib-std"
import {QuantumClock} from "@opendaw/lib-dsp"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {
    RecordingProcessorChannel,
    RecordingProcessorOptions,
    RecordingProcessorToClient,
    RingBuffer
} from "@opendaw/studio-adapters"

// a stale first read is corrected by any true read among the following quanta
const SETTLE_QUANTA = 16

export class RecordingProcessor extends AudioWorkletProcessor {
    readonly #writer: RingBuffer.Writer
    readonly #numberOfChannels: number
    readonly #client: RecordingProcessorToClient
    readonly #clock: QuantumClock = new QuantumClock()

    #firstQuantumCall: Option<int> = Option.None
    #announcedFirstQuantum: boolean = false

    constructor({processorOptions: config}: { processorOptions: RecordingProcessorOptions } & AudioNodeOptions) {
        super()

        this.#numberOfChannels = config.numberOfChannels
        this.#writer = RingBuffer.writer(config)
        this.#client = Communicator.sender<RecordingProcessorToClient>(
            Messenger.for(this.port).channel(RecordingProcessorChannel),
            dispatcher => new class implements RecordingProcessorToClient {
                firstQuantum(contextTime: number): void {dispatcher.dispatchAndForget(this.firstQuantum, contextTime)}
            })
    }

    process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
        const call = this.#clock.calls
        this.#clock.advance(currentFrame)
        if (this.#firstQuantumCall.isEmpty() && inputs[0]?.length === this.#numberOfChannels) {
            this.#firstQuantumCall = Option.wrap(call)
        }
        if (!this.#announcedFirstQuantum && this.#firstQuantumCall.nonEmpty()
            && call - this.#firstQuantumCall.unwrap() >= SETTLE_QUANTA) {
            this.#announcedFirstQuantum = true
            // context time of ring frame 0: the reader's frame count trails the audio thread and cannot serve as that clock
            this.#client.firstQuantum(this.#clock.frameOf(this.#firstQuantumCall.unwrap()) / sampleRate)
        }
        this.#writer.write(inputs[0])
        return true
    }
}