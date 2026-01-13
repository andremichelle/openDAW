import {clamp, clampUnit, exponential, int} from "@moises-ai/lib-std"
import {dbToGain} from "./utils"
import {StereoMatrix} from "./stereo"
import {BiquadCoeff} from "./biquad-coeff"
import {BiquadMono, BiquadProcessor} from "./biquad-processor"
import {RenderQuantum} from "./constants"

const DEFAULT_RAMP_DURATION_SECONDS = 0.020
const MIN_CUTOFF_FREQ = 1000.0

export class Crusher {
    readonly #sampleRate: number
    readonly #rampLength: int

    readonly #filterCoeff: BiquadCoeff
    readonly #filters: [BiquadProcessor, BiquadProcessor]
    readonly #filteredBuffer: StereoMatrix.Channels
    readonly #heldSample: Float32Array

    #crushedSampleRate: number = NaN
    #targetCrushedSampleRate: number = NaN
    #delta: number = 0.0
    #remaining: int = 0

    #phase: number = 0.0
    #bitDepth: number = 8
    #boostDb: number = 0.0
    #mix: number = 1.0

    #processed: boolean = false

    constructor(sampleRate: number) {
        this.#sampleRate = sampleRate
        this.#rampLength = Math.ceil(sampleRate * DEFAULT_RAMP_DURATION_SECONDS) | 0

        this.#filterCoeff = new BiquadCoeff()
        this.#filterCoeff.setLowpassParams(0.5) // nyquist
        this.#filters = [new BiquadMono(), new BiquadMono()]
        this.#filteredBuffer = [new Float32Array(RenderQuantum), new Float32Array(RenderQuantum)]
        this.#heldSample = new Float32Array(2)
    }

    process(input: StereoMatrix.Channels, output: StereoMatrix.Channels, from: int, to: int): void {
        const [inpL, inpR] = input
        const [outL, outR] = output
        const [fltL, fltR] = this.#filteredBuffer
        this.#filters[0].process(this.#filterCoeff, inpL, fltL, from, to)
        this.#filters[1].process(this.#filterCoeff, inpR, fltR, from, to)
        const preGain = dbToGain(this.#boostDb)
        const postGain = dbToGain(-this.#boostDb / 2.0) // half is more balanced for some reason
        const crushRatio = this.#sampleRate / this.#crushedSampleRate
        const steps = Math.pow(2.0, this.#bitDepth) - 1.0
        const stepInv = 1.0 / steps
        for (let i = from; i < to; i++) {
            if (this.#remaining > 0) {
                this.#crushedSampleRate += this.#delta
                if (0 === --this.#remaining) {
                    this.#delta = 0.0
                    this.#crushedSampleRate = this.#targetCrushedSampleRate
                }
                this.#filterCoeff.setLowpassParams(Math.max(this.#crushedSampleRate, MIN_CUTOFF_FREQ) / this.#sampleRate)
            }
            this.#phase += 1.0
            if (this.#phase >= crushRatio) {
                this.#phase -= crushRatio
                this.#heldSample[0] = clamp(Math.round(fltL[i] * preGain * steps) * stepInv, -1.0, 1.0)
                this.#heldSample[1] = clamp(Math.round(fltR[i] * preGain * steps) * stepInv, -1.0, 1.0)
            }
            outL[i] = (inpL[i] * (1.0 - this.#mix) + this.#heldSample[0] * this.#mix) * postGain
            outR[i] = (inpR[i] * (1.0 - this.#mix) + this.#heldSample[1] * this.#mix) * postGain
        }
        this.#processed = true
    }

    setCrush(value: number): void {
        const target = exponential(20.0, this.#sampleRate * 0.5, value) // max: nyquist
        if (this.#processed && isFinite(this.#crushedSampleRate)) {
            this.#targetCrushedSampleRate = target
            this.#delta = (target - this.#crushedSampleRate) / this.#rampLength
            this.#remaining = this.#rampLength
        } else {
            this.#crushedSampleRate = target
            this.#filterCoeff.setLowpassParams(Math.max(this.#crushedSampleRate, MIN_CUTOFF_FREQ) / this.#sampleRate)
        }
    }

    setBitDepth(bits: int): void {this.#bitDepth = clamp(bits, 1, 16)}

    setBoost(db: number): void {this.#boostDb = db}

    setMix(mix: number): void {this.#mix = clampUnit(mix)}

    reset(): void {
        this.#processed = false
        this.#targetCrushedSampleRate = NaN
        this.#delta = 0.0
        this.#remaining = 0
        this.#phase = 0.0
        this.#heldSample.fill(0.0)
        this.#filters[0].reset()
        this.#filters[1].reset()
    }
}