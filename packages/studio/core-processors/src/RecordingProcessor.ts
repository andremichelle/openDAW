import {RecordingProcessorOptions, RingBuffer} from "@moises-ai/studio-adapters"

export class RecordingProcessor extends AudioWorkletProcessor {
    readonly #writer: RingBuffer.Writer

    constructor({processorOptions: config}: { processorOptions: RecordingProcessorOptions } & AudioNodeOptions) {
        super()

        this.#writer = RingBuffer.writer(config)
    }

    process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
        this.#writer.write(inputs[0])
        return true
    }
}