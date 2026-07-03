import {ClassicWaveform} from "./classic-waveform"
import {fastSinTau} from "./fast-math"

export class LFO {
    #phase = 0.0

    constructor(readonly sampleRate: number) {}

    fill(buffer: Float32Array, shape: ClassicWaveform, frequency: number, fromIndex: number, toIndex: number): void {
        const phaseInc = frequency / this.sampleRate
        switch (shape) {
            case ClassicWaveform.sine: {
                for (let i = fromIndex; i < toIndex; i++) {
                    // WASM CONTRACT: `fastSinTau` mirrors `dsp::fast_math` (identical arithmetic in both engines)
                    buffer[i] = fastSinTau(this.#phase)
                    this.#phase += phaseInc
                    if (this.#phase >= 1.0) { this.#phase -= 1.0 }
                }
                break
            }
            case ClassicWaveform.triangle: {
                for (let i = fromIndex; i < toIndex; i++) {
                    const phase = this.#phase % 1.0
                    buffer[i] = 4.0 * Math.abs(phase - 0.5) - 1.0
                    this.#phase += phaseInc
                    if (this.#phase >= 1.0) { this.#phase -= 1.0 }
                }
                break
            }
            case ClassicWaveform.saw: {
                for (let i = fromIndex; i < toIndex; i++) {
                    const phase = this.#phase % 1.0
                    buffer[i] = 2.0 * phase - 1.0
                    this.#phase += phaseInc
                    if (this.#phase >= 1.0) { this.#phase -= 1.0 }
                }
                break
            }
            case ClassicWaveform.square: {
                for (let i = fromIndex; i < toIndex; i++) {
                    const phase = this.#phase % 1.0
                    buffer[i] = phase < 0.5 ? 1.0 : -1.0
                    this.#phase += phaseInc
                    if (this.#phase >= 1.0) { this.#phase -= 1.0 }
                }
                break
            }
        }
    }

    reset(): void {
        this.#phase = 0.0
    }
}