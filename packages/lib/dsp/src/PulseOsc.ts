/**
 * BAND-LIMITED PULSE WAVE OSCILLATOR
 *
 * https://github.com/rcliftonharvey/rchoscillators/blob/master/library/oscillators/templates/bandlimited/pulse.h
 */
import {TAU} from "@moises-ai/lib-std"

const M_2_PI = 2.0 / Math.PI

export class Pulse {
    readonly #samplerate: number
    readonly #nyquist: number
    readonly #dcFactor: number = 1.56

    #frequency: number = 440.0
    #fractionFrequency: number = 0.0
    #phase: number = 0.0
    #width: number = 0.5
    #maxHarmonics: number = 100
    #numHarmonics: number = 10
    #direction: number = 1.0
    #frequencyChanged: boolean = true

    constructor(sampleRate: number) {
        this.#samplerate = sampleRate
        this.#nyquist = sampleRate * 0.5
    }

    reset(): void {
        this.#phase = 0.0
        this.#frequencyChanged = true
    }

    setFrequency(hz: number): void {
        this.#frequency = Math.min(hz, this.#nyquist)
        this.#frequencyChanged = true
    }

    setPulseWidth(value: number): void {
        this.#width = Math.max(0, Math.min(1, value))
    }

    tick(): number {
        console.assert(this.#samplerate > 0.0, "Samplerate not correctly set")
        console.assert(this.#nyquist === this.#samplerate * 0.5, "Samplerate not correctly set")
        console.assert(this.#frequency <= this.#nyquist, "Frequency can't be above nyquist")

        if (this.#frequencyChanged) {
            this.#fractionFrequency = this.#frequency / this.#samplerate
            if (this.#frequency > 0.0) {
                this.#numHarmonics = Math.min(this.#maxHarmonics, Math.floor(this.#nyquist / this.#frequency))
            } else {
                this.#numHarmonics = 0
            }
            this.#frequencyChanged = false
        }

        this.#phase += this.#fractionFrequency
        this.#phase += ((this.#phase >= 1.0 ? 1 : 0) * -1.0) + ((this.#phase < 0.0 ? 1 : 0) * 1.0)

        let shiftedPhase = this.#phase + this.#width
        shiftedPhase += ((shiftedPhase >= 1.0 ? 1 : 0) * -1.0) + ((shiftedPhase < 0.0 ? 1 : 0) * 1.0)

        let state = 0.0
        let dunHarmonics = 0
        for (let harmonic = 1; dunHarmonics < this.#numHarmonics; harmonic++, dunHarmonics++) {
            const harmonicPhase = (this.#phase * -this.#direction) * harmonic
            const harmonicPhase2 = (shiftedPhase * this.#direction) * harmonic
            state += (Math.sin(harmonicPhase * TAU) + Math.sin(harmonicPhase2 * TAU)) / harmonic
        }
        state += this.#width * this.#dcFactor + (1.0 - this.#width) * -this.#dcFactor
        state *= M_2_PI
        return state
    }
}