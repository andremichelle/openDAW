import {FFT, Window} from "@moises-ai/lib-dsp"
import {int} from "@moises-ai/lib-std"

export class AudioAnalyser {
    static readonly DEFAULT_SIZE = 512
    static readonly DECAY = 0.90

    readonly #fftSize: number
    readonly #numBins: number
    readonly #fft: FFT
    readonly #real: Float32Array
    readonly #imag: Float32Array
    readonly #window: Float32Array
    readonly #bins: Float32Array
    readonly #waveform: Float32Array

    #index: number = 0

    decay: boolean = false

    constructor(size: int = AudioAnalyser.DEFAULT_SIZE) {
        this.#fftSize = size << 1
        this.#fft = new FFT(this.#fftSize)
        this.#real = new Float32Array(this.#fftSize)
        this.#imag = new Float32Array(this.#fftSize)
        this.#window = Window.create(Window.Type.Blackman, this.#fftSize)
        this.#numBins = size
        this.#bins = new Float32Array(size)
        this.#waveform = new Float32Array(size)
    }

    clear(): void {
        this.#bins.fill(0.0)
        this.#real.fill(0.0)
        this.#waveform.fill(0.0)
        this.#index = 0
    }

    reset(): void {
        this.#index = 0
    }

    numBins(): int {return this.#numBins}
    bins(): Float32Array {return this.#bins}
    waveform(): Float32Array {return this.#waveform}

    process(left: Float32Array, right: Float32Array, fromIndex: int, toIndex: int): void {
        for (let i = fromIndex; i < toIndex; ++i) {
            this.#real[this.#index] = left[i] + right[i]
            if (++this.#index === this.#fftSize) {
                this.#update()
            }
        }
    }

    #update(): void {
        for (let i = 0; i < this.#numBins; ++i) {
            this.#waveform[i] = this.#real[i << 1]
        }
        for (let i = 0; i < this.#fftSize; ++i) {
            this.#real[i] *= this.#window[i]
        }
        this.#fft.process(this.#real, this.#imag)
        const scale = 1.0 / this.#numBins
        for (let i = 0; i < this.#numBins; ++i) {
            const re = this.#real[i]
            const im = this.#imag[i]
            const energy = Math.sqrt(re * re + im * im) * scale
            if (this.#bins[i] < energy) {
                this.#bins[i] = energy
            } else if (this.decay) {
                this.#bins[i] *= AudioAnalyser.DECAY
            }
        }
        this.#index = 0
        this.#imag.fill(0.0)
        this.decay = false
    }
}