import {Gate, PlayfieldSampleBoxAdapter} from "@moises-ai/studio-adapters"
import {AudioData, NoteEvent, velocityToGain} from "@moises-ai/lib-dsp"
import {Id, int} from "@moises-ai/lib-std"
import {AutomatableParameters} from "./AutomatableParameters"

const FAST_RELEASE = Math.floor(0.005 * sampleRate)

export class SampleVoice {
    readonly #sample: PlayfieldSampleBoxAdapter
    readonly #parameters: AutomatableParameters
    readonly #event: Id<NoteEvent>
    readonly #data: AudioData

    readonly #gate: Gate
    readonly #gain: number

    #envPosition: int = 0 | 0

    #decayPosition: int = Number.POSITIVE_INFINITY
    #attack: number
    #release: number
    #start: number
    #end: number
    #position: number
    #envelope: number

    #active: boolean = true
    #released: boolean = false

    constructor(sample: PlayfieldSampleBoxAdapter,
                parameters: AutomatableParameters,
                data: AudioData,
                event: Id<NoteEvent>) {
        this.#sample = sample
        this.#parameters = parameters
        this.#data = data
        this.#event = event

        this.#gate = sample.gate
        this.#gain = velocityToGain(this.#event.velocity)

        const {attack, release, sampleStart, sampleEnd} = this.#parameters
        this.#attack = attack.getValue() * sampleRate
        this.#release = release.getValue() * sampleRate
        this.#start = (data.numberOfFrames - 1) * sampleStart.getValue()
        this.#end = (data.numberOfFrames - 1) * sampleEnd.getValue()
        this.#position = this.#start
        this.#envelope = 0.0
    }

    get sample(): PlayfieldSampleBoxAdapter {return this.#sample}
    get event(): Id<NoteEvent> {return this.#event}
    get position(): number {return this.#position}
    get envelope(): number {return this.#envelope}

    release(force: boolean = false): void {
        if (!this.#active) {return}
        if (force) {
            this.#release = FAST_RELEASE
            this.#releaseEnvelope()
            this.#active = false
        } else if (this.#gate !== Gate.Off) {
            this.#releaseEnvelope()
        }
    }

    processAdd(output: ReadonlyArray<Float32Array>, fromIndex: int, toIndex: int): boolean {
        const [outL, outR] = output
        const {frames, numberOfFrames} = this.#data
        const inpL = frames[0]
        const inpR = frames[1] ?? inpL
        const {pitch} = this.#parameters
        const distance = this.#end - this.#start
        const sign = Math.sign(distance)
        const rateRatio = this.#data.sampleRate / sampleRate * sign * (2.0 ** (pitch.getValue() / 1200.0))
        let env = 0.0
        for (let i = fromIndex; i < toIndex; i++) {
            const intPosition = this.#position | 0
            const frac = this.#position - intPosition
            const l = inpL[intPosition] * (1.0 - frac) + (inpL[intPosition + 1] ?? 0.0) * frac
            const r = inpR[intPosition] * (1.0 - frac) + (inpR[intPosition + 1] ?? 0.0) * frac
            env = Math.min(this.#envPosition / this.#attack,
                1.0 - (this.#envPosition - (this.#decayPosition + this.#attack)) / this.#release, 1.0)
            this.#position += rateRatio
            if (sign > 0.0) {
                if (this.#gate === Gate.Off) {
                    if (this.#position >= numberOfFrames) {return true}
                    if (!this.#released && this.#position >= this.#end) {
                        this.#releaseEnvelope()
                    }
                } else if (this.#gate === Gate.On) {
                    if (this.#position >= this.#end - FAST_RELEASE) {
                        if (this.#position >= this.#end) {return true}
                        env *= (this.#end - this.#position) / FAST_RELEASE
                    }
                } else if (this.#gate === Gate.Loop) {
                    while (this.#position >= this.#end) {this.#position -= distance}
                }
            } else if (sign < 0.0) {
                if (this.#gate === Gate.Off) {
                    if (this.#position <= 0) {return true}
                    if (!this.#released && this.#position <= this.#end) {
                        this.#releaseEnvelope()
                    }
                } else if (this.#gate === Gate.On) {
                    if (this.#position <= this.#end + FAST_RELEASE) {
                        if (this.#position <= this.#end) {return true}
                        env *= (this.#end - this.#position) / FAST_RELEASE
                    }
                } else if (this.#gate === Gate.Loop) {
                    while (this.#position <= this.#end) {this.#position -= distance}
                }
            }
            if (++this.#envPosition - this.#decayPosition > this.#attack + this.#release) {return true}
            env *= this.#gain * env
            outL[i] += l * env
            outR[i] += r * env
        }
        this.#envelope = env
        return false
    }

    toString(): string {return "{PlayfieldSampleVoice}"}

    #releaseEnvelope(): void {
        if (this.#released) {return}
        this.#released = true
        this.#decayPosition = this.#envPosition < this.#attack
            ? this.#envPosition - this.#attack
            : this.#envPosition
    }
}