import {int} from "@moises-ai/lib-std"
import {AudioBuffer} from "../AudioBuffer"

// Delay Line for lookahead
export class DelayLine {
    readonly #delayBuffer: Float32Array[] = []
    readonly #delayBufferSize: int
    readonly #delayInSamples: int
    readonly #numChannels: int

    #writePosition: int = 0

    constructor(sampleRate: number, delayInSeconds: number, maxBlockSize: int, numChannels: int) {
        this.#numChannels = numChannels
        this.#delayInSamples = Math.floor(sampleRate * delayInSeconds)
        this.#delayBufferSize = maxBlockSize + this.#delayInSamples
        for (let ch = 0; ch < numChannels; ch++) {
            this.#delayBuffer[ch] = new Float32Array(this.#delayBufferSize)
        }
        this.#writePosition = 0
    }

    process(buffer: AudioBuffer, fromIndex: int, toIndex: int): void {
        if (this.#delayInSamples === 0) {return}
        let readPosition = (this.#writePosition - this.#delayInSamples + this.#delayBufferSize) % this.#delayBufferSize
        for (let ch = 0; ch < this.#numChannels; ch++) {
            const channelData = buffer.getChannel(ch)
            let writePos = this.#writePosition
            let readPos = readPosition
            for (let i = fromIndex; i < toIndex; i++) {
                const delayedSample = this.#delayBuffer[ch][readPos]
                this.#delayBuffer[ch][writePos] = channelData[i]
                channelData[i] = delayedSample
                writePos = (writePos + 1) % this.#delayBufferSize
                readPos = (readPos + 1) % this.#delayBufferSize
            }
        }
        this.#writePosition = (this.#writePosition + (toIndex - fromIndex)) % this.#delayBufferSize
    }
}