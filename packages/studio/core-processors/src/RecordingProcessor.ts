import {RecordingProcessorOptions, RingBuffer} from "@opendaw/studio-adapters"

export class RecordingProcessor extends AudioWorkletProcessor {
    readonly #writer: RingBuffer.Writer
    readonly #numberOfChannels: number

    #announcedFirstQuantum: boolean = false

    constructor({processorOptions: config}: { processorOptions: RecordingProcessorOptions } & AudioNodeOptions) {
        super()

        this.#numberOfChannels = config.numberOfChannels
        this.#writer = RingBuffer.writer(config)
    }

    process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
        if (!this.#announcedFirstQuantum && inputs[0]?.length === this.#numberOfChannels) {
            this.#announcedFirstQuantum = true
            // Report the audio-thread time of the buffer's first frame, once, under the same
            // channel-count gate the ring writer applies (setup-phase quanta arrive without
            // channels and are not written). The main thread pairs it with the engine's own
            // audio-thread anchors; the ring reader's frame counter cannot serve as that clock
            // because chunk delivery trails the audio thread.
            this.port.postMessage({type: "first-quantum", contextTime: currentTime})
        }
        this.#writer.write(inputs[0])
        return true
    }
}