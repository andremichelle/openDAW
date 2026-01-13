import {Arrays, assert, int} from "@moises-ai/lib-std"
import {RenderQuantum} from "./constants"

export class AudioBuffer {
    static Empty = new AudioBuffer(2)

    readonly #channels: ReadonlyArray<Float32Array>

    constructor(numberOfChannels: int = 2) {
        this.#channels = Arrays.create(() => new Float32Array(RenderQuantum), numberOfChannels)
    }

    clear(start?: int, end?: int): void {this.#channels.forEach(channel => channel.fill(0.0, start, end))}
    numChannels(): int {return this.#channels.length}
    getChannel(channelIndex: int): Float32Array {
        return channelIndex < this.numChannels() ? this.#channels[channelIndex] : this.#channels[this.numChannels() - 1]
    }
    assertSanity(): void {
        assert(!this.#channels.some(channel => channel.some(number => isNaN(number))), "AudioBuffer is invalid (NaN)")
    }
    channels(): ReadonlyArray<Float32Array> {return this.#channels}
    replace(output: AudioBuffer): void {this.replaceInto(output.#channels)}
    replaceInto(target: ReadonlyArray<Float32Array>): void {
        // https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API#up-mixing_and_down-mixing
        assert(target.length === 2, "mixLayout: target.length must be 2")
        assert(this.#channels.length === 1 || this.#channels.length === 2, "mixLayout: target.length must be 1 or 2")
        if (this.#channels.length === 1) {
            target[0].set(this.#channels[0])
            target[1].set(this.#channels[0])
        } else {
            target[0].set(this.#channels[0])
            target[1].set(this.#channels[1])
        }
    }
    mixInto(target: ReadonlyArray<Float32Array>): void {
        assert(target.length === 2, "mixLayout: target.length must be 2")
        assert(this.#channels.length === 1 || this.#channels.length === 2, "mixLayout: target.length must be 1 or 2")
        const [outL, outR] = target
        if (this.#channels.length === 1) {
            const [inp] = this.#channels
            for (let i = 0; i < RenderQuantum; i++) {
                outL[i] += inp[i]
                outR[i] += inp[i]
            }
        } else {
            const [inpL, inpR] = this.#channels
            for (let i = 0; i < RenderQuantum; i++) {
                outL[i] += inpL[i]
                outR[i] += inpR[i]
            }
        }
    }
}