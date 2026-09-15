import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {
    RecordingProcessorChannel,
    RecordingProcessorOptions,
    RecordingProcessorToClient,
    RingBuffer
} from "@opendaw/studio-adapters"

export class RecordingProcessor extends AudioWorkletProcessor {
    readonly #writer: RingBuffer.Writer
    readonly #numberOfChannels: number
    readonly #client: RecordingProcessorToClient

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
        if (!this.#announcedFirstQuantum && inputs[0]?.length === this.#numberOfChannels) {
            this.#announcedFirstQuantum = true
            // context time of ring frame 0: the reader's frame count trails the audio thread and cannot serve as that clock
            this.#client.firstQuantum(currentTime)
        }
        this.#writer.write(inputs[0])
        return true
    }
}