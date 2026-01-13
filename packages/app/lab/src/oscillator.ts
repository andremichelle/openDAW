import {Waveform} from "./waveform"
import {TAU} from "@moises-ai/lib-std"

export class Oscillator {
    waveform: Waveform = Waveform.SINE
    phase = 0.0
    phaseInc = 0.0
    lastOut = 0.0
    pw = 0.5
    amp = 1.0
    eoc = false
    eor = false
    srRecip: number

    constructor(sampleRate: number) {
        this.srRecip = 1.0 / sampleRate
    }

    setWaveform(waveform: Waveform): void {
        this.waveform = waveform
    }

    setFrequency(f: number): void {
        this.phaseInc = f * this.srRecip
    }

    process(): number {
        let out = 0.0
        let t = 0.0

        switch (this.waveform) {
            case Waveform.SINE:
                out = Math.sin(this.phase * TAU)
                break

            case Waveform.POLYBLEP_TRI: {
                t = this.phase
                out = this.phase < 0.5 ? 1.0 : -1.0
                out += polyblep(this.phaseInc, t)
                out -= polyblep(this.phaseInc, fastmod1f(t + 0.5))
                // Leaky Integrator:
                out = this.phaseInc * out + (1.0 - this.phaseInc) * this.lastOut
                this.lastOut = out
                out *= 4.0 // normalize
                break
            }

            case Waveform.POLYBLEP_SAW: {
                t = this.phase
                out = (2.0 * t) - 1.0
                out -= polyblep(this.phaseInc, t)
                out *= -1.0
                break
            }

            case Waveform.POLYBLEP_SQUARE: {
                t = this.phase
                out = this.phase < this.pw ? 1.0 : -1.0
                out += polyblep(this.phaseInc, t)
                out -= polyblep(this.phaseInc, fastmod1f(t + (1.0 - this.pw)))
                out *= 0.707 // scaling factor
                break
            }

            default:
                out = 0.0
                break
        }

        this.phase += this.phaseInc
        if (this.phase > 1.0) {
            this.phase -= 1.0
            this.eoc = true
        } else {
            this.eoc = false
        }
        this.eor = this.phase - this.phaseInc < 0.5 && this.phase >= 0.5

        return out * this.amp
    }
}

// --- Helpers ---

function fastmod1f(x: number): number {
    return x - Math.floor(x)
}

function polyblep(phaseInc: number, t: number): number {
    const dt = phaseInc
    if (t < dt) {
        t /= dt
        return t + t - t * t - 1.0
    } else if (t > 1.0 - dt) {
        t = (t - 1.0) / dt
        return t * t + t + t + 1.0
    } else {
        return 0.0
    }
}