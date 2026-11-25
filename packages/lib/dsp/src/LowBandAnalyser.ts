import {int} from "@opendaw/lib-std"
import {BiquadCoeff} from "./biquad-coeff"
import {BiquadStack} from "./biquad-processor"
import {FFT} from "./fft"
import {Window} from "./window"

const FFT_SIZE = 1024
const HOP = 1024
const TARGET_RATE = 6000.0
const FILTER_SECTIONS = 4

export class LowBandAnalyser {
    static readonly NUM_BINS = 64
    static readonly CROSSOVER = 300.0
    static readonly DEFAULT_DECAY = 0.90

    static decimation(sampleRate: number): int {return 1 << Math.round(Math.log2(sampleRate / TARGET_RATE))}
    static binWidth(sampleRate: number): number {return sampleRate / (LowBandAnalyser.decimation(sampleRate) * FFT_SIZE)}

    readonly #decimation: int
    readonly #hop: int
    readonly #coeff: BiquadCoeff
    readonly #filter: BiquadStack
    readonly #fft: FFT
    readonly #ring: Float32Array
    readonly #real: Float32Array
    readonly #imag: Float32Array
    readonly #window: Float32Array
    readonly #bins: Float32Array

    #phase: int = 0
    #writeIndex: int = 0
    #sinceUpdate: int = 0

    decay: boolean = false

    constructor(sampleRate: number) {
        this.#decimation = LowBandAnalyser.decimation(sampleRate)
        this.#hop = HOP / this.#decimation
        this.#coeff = new BiquadCoeff().setLowpassParams(0.25 / this.#decimation)
        this.#filter = new BiquadStack(FILTER_SECTIONS)
        this.#fft = new FFT(FFT_SIZE)
        this.#ring = new Float32Array(FFT_SIZE)
        this.#real = new Float32Array(FFT_SIZE)
        this.#imag = new Float32Array(FFT_SIZE)
        this.#window = Window.create(Window.Type.Blackman, FFT_SIZE)
        this.#bins = new Float32Array(LowBandAnalyser.NUM_BINS)
    }

    clear(): void {
        this.#filter.reset()
        this.#ring.fill(0.0)
        this.#bins.fill(0.0)
        this.#phase = 0
        this.#writeIndex = 0
        this.#sinceUpdate = 0
    }

    bins(): Float32Array {return this.#bins}

    process(left: Float32Array, right: Float32Array, fromIndex: int, toIndex: int): void {
        for (let i = fromIndex; i < toIndex; ++i) {
            const filtered = this.#filter.processFrame(this.#coeff, left[i] + right[i])
            if (++this.#phase < this.#decimation) {continue}
            this.#phase = 0
            this.#ring[this.#writeIndex] = filtered
            this.#writeIndex = (this.#writeIndex + 1) & (FFT_SIZE - 1)
            if (++this.#sinceUpdate === this.#hop) {
                this.#sinceUpdate = 0
                this.#update()
            }
        }
    }

    #update(): void {
        for (let i = 0; i < FFT_SIZE; ++i) {
            this.#real[i] = this.#ring[(this.#writeIndex + i) & (FFT_SIZE - 1)] * this.#window[i]
        }
        this.#imag.fill(0.0)
        this.#fft.process(this.#real, this.#imag)
        const scale = 2.0 / FFT_SIZE
        for (let i = 0; i < LowBandAnalyser.NUM_BINS; ++i) {
            const re = this.#real[i]
            const im = this.#imag[i]
            const energy = Math.sqrt(re * re + im * im) * scale
            if (this.#bins[i] < energy) {
                this.#bins[i] = energy
            } else if (this.decay) {
                this.#bins[i] *= LowBandAnalyser.DEFAULT_DECAY
            }
        }
        this.decay = false
    }
}
