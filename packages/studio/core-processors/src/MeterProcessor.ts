import {PeakMeterProcessorOptions} from "@moises-ai/studio-adapters"
import {RenderQuantum, RMS} from "@moises-ai/lib-dsp"
import {Arrays, int, Schema, SyncStream} from "@moises-ai/lib-std"

export class MeterProcessor extends AudioWorkletProcessor {
    readonly #numberOfChannels: int
    readonly #maxPeak: Float32Array
    readonly #maxSquared: Float32Array
    readonly #rmsChannels: ReadonlyArray<RMS>
    readonly #writer: SyncStream.Writer

    #blocksProcessed: int = 0 | 0

    constructor({processorOptions: {sab, numberOfChannels, rmsWindowInSeconds, valueDecay}}: {
        processorOptions: PeakMeterProcessorOptions
    } & AudioNodeOptions) {
        super()

        this.#numberOfChannels = numberOfChannels
        this.#maxPeak = new Float32Array(numberOfChannels)
        this.#maxSquared = new Float32Array(numberOfChannels)
        this.#rmsChannels = Arrays.create(() => new RMS(sampleRate * rmsWindowInSeconds), numberOfChannels)

        const io = Schema.createBuilder({
            peak: Schema.floats(numberOfChannels),
            rms: Schema.floats(numberOfChannels)
        })()

        this.#writer = SyncStream.writer(io, sab, x => {
            const valueDecayMultiplier = Math.exp(-(128.0 * this.#blocksProcessed) / (sampleRate * valueDecay))
            for (let channelIndex: number = 0; channelIndex < numberOfChannels; ++channelIndex) {
                const peak = this.#maxPeak[channelIndex]
                const square = this.#maxSquared[channelIndex]
                x.peak[channelIndex] = peak
                x.rms[channelIndex] = Math.sqrt(square)
                this.#maxPeak[channelIndex] = peak * valueDecayMultiplier
                this.#maxSquared[channelIndex] = square * valueDecayMultiplier
            }
            this.#blocksProcessed = 0
        })
    }

    process([input]: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
        for (let channel: int = 0; channel < this.#numberOfChannels; ++channel) {
            const inputChannel: Float32Array = input[channel]
            if (undefined === inputChannel) {
                this.#maxPeak[channel] = 0.0
                this.#maxSquared[channel] = 0.0
            } else {
                const rms: RMS = this.#rmsChannels[channel]
                let peak: number = this.#maxPeak[channel]
                let squared: number = this.#maxSquared[channel]
                for (let i: int = 0 | 0; i < RenderQuantum; ++i) {
                    const inp = inputChannel[i] // we pass the signal
                    peak = Math.max(peak, Math.abs(inp))
                    squared = Math.max(squared, rms.pushPop(inp * inp))
                }
                this.#maxPeak[channel] = peak
                this.#maxSquared[channel] = squared
            }
        }
        this.#blocksProcessed++
        this.#writer.tryWrite()
        return true
    }
}