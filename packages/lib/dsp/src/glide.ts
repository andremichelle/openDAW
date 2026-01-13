import {PPQN, ppqn} from "./ppqn"
import {int} from "@moises-ai/lib-std"

export class Glide {
    #beginFrequency: number = 0.0
    #currentFrequency: number = NaN
    #targetFrequency: number = NaN
    #glidePosition: number = 0.0
    #glideDuration: number = 0.0

    constructor() {}

    reset(): void {
        this.#beginFrequency = 0.0
        this.#currentFrequency = NaN
        this.#targetFrequency = NaN
        this.#glidePosition = 0.0
        this.#glideDuration = 0.0
    }

    init(frequency: number): void {
        this.#beginFrequency = frequency
        if (isNaN(this.#currentFrequency)) {
            this.#currentFrequency = this.#beginFrequency
        }
    }

    currentFrequency(): number {return this.#currentFrequency}

    glideTo(targetFrequency: number, glideDuration: ppqn): void {
        if (glideDuration === 0.0) {
            this.#beginFrequency = targetFrequency
            return
        }
        this.#beginFrequency = this.#currentFrequency
        this.#targetFrequency = targetFrequency
        this.#glidePosition = 0.0
        this.#glideDuration = glideDuration
    }

    process(freqBuffer: Float32Array, bpm: number, fromIndex: int, toIndex: int): void {
        if (isNaN(this.#targetFrequency)) {
            for (let i = fromIndex; i < toIndex; i++) {freqBuffer[i] *= this.#beginFrequency}
            this.#currentFrequency = this.#beginFrequency
        } else {
            const ppqnPerSample = PPQN.samplesToPulses(1, bpm, sampleRate)
            for (let i = fromIndex; i < toIndex; i++) {
                this.#glidePosition += ppqnPerSample / this.#glideDuration
                if (this.#glidePosition >= 1.0) {
                    this.#glidePosition = 1.0
                    this.#beginFrequency = this.#targetFrequency
                    this.#targetFrequency = NaN
                    for (let j = i; j < toIndex; j++) {freqBuffer[j] *= this.#beginFrequency}
                    break
                }
                freqBuffer[i] *= this.#currentFrequency =
                    this.#beginFrequency + (this.#targetFrequency - this.#beginFrequency) * this.#glidePosition
            }
        }
    }

    advance(bpm: number, fromIndex: int, toIndex: int): void {
        if (isNaN(this.#targetFrequency)) {
            this.#currentFrequency = this.#beginFrequency
        } else {
            const ppqnDelta = PPQN.samplesToPulses(toIndex - fromIndex, bpm, sampleRate)
            this.#glidePosition += ppqnDelta / this.#glideDuration
            if (this.#glidePosition >= 1.0) {
                this.#glidePosition = 1.0
                this.#beginFrequency = this.#currentFrequency = this.#targetFrequency
                this.#targetFrequency = NaN
            } else {
                this.#currentFrequency =
                    this.#beginFrequency + (this.#targetFrequency - this.#beginFrequency) * this.#glidePosition
            }
        }
    }
}