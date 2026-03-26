// Deterministic Matrix Synth -> Deminix
// by Chaosmeister - https://github.com/Chaosmeister
// Version 2
// added separate fine - tuning controls for the amount of applied Tremolo, Vibrato, FMod, Attack & Release without changing the sound itself too much
// removed randomized Pan - is already controllable through opendaw
// removed final 0.25 multiplicator -> now 4x louder sounds
// added Volume control to be able to prevent clipping 

// The UI is created column-wise but I like row-wise better
// @param 1         5   1   9  int
// @param 4         5   1   9  int
// @param 7         5   1   9  int
// @param 2         5   1   9  int
// @param 5         5   1   9  int
// @param 8         5   1   9  int
// @param 3         5   1   9  int
// @param 6         5   1   9  int
// @param 9         5   1   9  int
// @param tremolo   1   0   1  linear
// @param vibrato   1   0   1  linear
// @param fmod      1   0   1  linear
// @param attack    1   0   1  linear
// @param release   1   0   1  linear
// @param volume    1   0   1  linear

// ─── Deterministic PRNG (Mulberry32) ──────────────────────────────────────
class RNG {
    constructor(seed) {
        this.s = seed >>> 0
    }
    next() {
        this.s = (this.s + 0x6D2B79F5) >>> 0
        let t = this.s
        t = Math.imul(t ^ (t >>> 15), 1 | t)
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    range(lo, hi) { return lo + this.next() * (hi - lo) }
    int(lo, hi) { return Math.floor(lo + this.next() * (hi - lo + 1)) }
}

// ─── Waveshape functions ───────────────────────────────────────────────────
function waveSine(ph) { return Math.sin(ph * 6.283185307) }
function waveTri(ph) { const p = ph % 1; return p < 0.5 ? 4 * p - 1 : 3 - 4 * p }
function waveSaw(ph) { return 2 * (ph % 1) - 1 }
function waveSquare(ph) { return (ph % 1) < 0.5 ? 1 : -1 }
function wavePulse(ph) { return (ph % 1) < 0.25 ? 1 : -1 }

const WAVEFNS = [waveSine, waveTri, waveSaw, waveSquare, wavePulse]

// ─── Voice ─────────────────────────────────────────────────────────────────
class Voice {
    constructor(maxPartials) {
        this.id = -1
        this.active = false
        this.gate = false
        this.freq = 440
        this.velocity = 1
        this.gain = 0
        this.attackRate = 0
        this.releaseRate = 0
        this.sustainGain = 0.6
        this.numPartials = 1
        this.phases = new Float32Array(maxPartials)
        this.freqMul = new Float32Array(maxPartials)
        this.amps = new Float32Array(maxPartials)
        this.detuneAmt = new Float32Array(maxPartials)
        this.waveType = new Uint8Array(maxPartials)
        this.fmPhase = 0
        this.fmFreqMul = 1
        this.fmDepth = 0
        this.tremPhase = 0
        this.tremRate = 0
        this.tremDepth = 0
        this.vibPhase = 0
        this.vibRate = 0
        this.vibDepth = 0
    }
}

// ─── Processor ────────────────────────────────────────────────────────────
class Processor {
    static MAX_VOICES = 16
    static MAX_PARTIALS = 8

    voices = []
    params = new Int32Array(9)
    tremolo = 1
    vibrato = 1
    fmod = 1
    attack = 1
    release = 1
    volume = 1

    constructor() {
        for (let i = 0; i < Processor.MAX_VOICES; i++) {
            const v = new Voice(Processor.MAX_PARTIALS)
            v.active = false
            this.voices.push(v)
        }
    }

    paramChanged(name, value) {
        if (name === "1") this.params[0] = value;
        if (name === "2") this.params[1] = value;
        if (name === "3") this.params[2] = value;
        if (name === "4") this.params[3] = value;
        if (name === "5") this.params[4] = value;
        if (name === "6") this.params[5] = value;
        if (name === "7") this.params[6] = value;
        if (name === "8") this.params[7] = value;
        if (name === "9") this.params[8] = value;
        if (name === "tremolo") this.tremolo = value;
        if (name === "vibrato") this.vibrato = value;
        if (name === "fmod") this.fmod = value;
        if (name === "attack") this.attack = value;
        if (name === "release") this.release = value;
        if (name === "volume") this.volume = value;
    }

    // Hash all 9 params into a single 32-bit seed
    _makeSeed() {
        let seed = 0
        let mul = 1
        for (const param of this.params) {
            seed += param * mul
            mul *= 10
        }
        return seed
    }

    _bakeVoice(voice, pitch, velocity, cent) {
        // One RNG seeded from params hash XOR pitch — everything comes from it
        const rng = new RNG(this._makeSeed())

        voice.freq = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
        voice.velocity = velocity
        voice.gain = 0
        voice.gate = true

        // ── Envelope ────────────────────────────────────────────────────
        const attackSec = 0.002 * Math.pow(1000, rng.next())   // 2ms – 2s
        const releaseSec = 0.01 * Math.pow(400, rng.next())   // 10ms – 4s
        voice.attackRate = 1 / (attackSec * sampleRate)
        voice.releaseRate = 1 / (releaseSec * sampleRate)
        voice.sustainGain = rng.range(0.3, 1.0)

        // ── Partials ─────────────────────────────────────────────────────
        const np = rng.int(1, Processor.MAX_PARTIALS)
        voice.numPartials = np

        // Harmonic style: 0=integer, 1=stretched, 2=sub, 3=inharmonic
        const spreadStyle = rng.int(0, 3)
        const brightness = rng.next()

        let totalAmp = 0
        for (let k = 0; k < np; k++) {
            const n = k + 1
            let mul
            if (spreadStyle === 0) {
                mul = n
            } else if (spreadStyle === 1) {
                mul = Math.pow(n, 1 + rng.next() * 0.6)
            } else if (spreadStyle === 2) {
                mul = n === 1 ? 1 : n * 0.5
            } else {
                mul = 1 + rng.next() * 6
            }
            voice.freqMul[k] = mul
            const falloff = Math.max(0.05, 1 - brightness * 0.9)
            voice.amps[k] = Math.pow(falloff, k) * (0.5 + 0.5 * rng.next())
            totalAmp += voice.amps[k]
            voice.phases[k] = rng.next()
            voice.detuneAmt[k] = (rng.next() - 0.5) * 0.006 * rng.next()
            voice.waveType[k] = rng.int(0, 4)
        }
        if (totalAmp > 0) {
            for (let k = 0; k < np; k++) voice.amps[k] /= totalAmp
        }

        // ── FM ───────────────────────────────────────────────────────────
        voice.fmFreqMul = 1 + rng.next() * 7
        voice.fmDepth = rng.next() * 6
        voice.fmPhase = rng.next()

        // ── Tremolo ───────────────────────────────────────────────────────
        voice.tremRate = rng.range(0.1, 12)
        voice.tremDepth = rng.next() * 0.8
        voice.tremPhase = rng.next()

        // ── Vibrato ───────────────────────────────────────────────────────
        voice.vibRate = rng.range(3, 7)
        voice.vibDepth = rng.next() * 0.015
        voice.vibPhase = rng.next()
    }

    noteOn(pitch, velocity, cent, id) {
        let voice = null
        for (const v of this.voices) {
            if (!v.active) { voice = v; break }
        }
        if (!voice) {
            let minGain = Infinity
            for (const v of this.voices) {
                if (v.gain < minGain) { minGain = v.gain; voice = v }
            }
        }
        voice.id = id
        voice.active = true
        this._bakeVoice(voice, pitch, velocity, cent)
    }

    noteOff(id) {
        for (const v of this.voices) {
            if (v.active && v.id === id) {
                v.gate = false
                break
            }
        }
    }

    reset() {
        for (const v of this.voices) {
            if (v.active) {
                v.gate = false
                v.releaseRate = 0.05
            }
        }
    }

    process(output, block) {
        const [outL, outR] = output
        const invSR = 1 / sampleRate

        for (let vi = 0; vi < this.voices.length; vi++) {
            const v = this.voices[vi]
            if (!v.active) continue

            for (let s = block.s0; s < block.s1; s++) {
                if (v.gate) {
                    const target = v.sustainGain * v.velocity
                    if (this.attack === 0) {
                        v.gain = target
                    }
                    else {
                        v.gain += (target - v.gain) * v.attackRate / this.attack
                    }
                } else {
                    if (this.release === 0) {
                        v.active = false
                        break
                    }
                    v.gain -= v.gain * v.releaseRate / this.release
                    if (v.gain < 0.00005) {
                        v.active = false
                        break
                    }
                }

                const vibMod = 1 + Math.sin(v.vibPhase * 6.283185307) * v.vibDepth * this.vibrato
                v.vibPhase += v.vibRate * invSR

                const fmSig = Math.sin(v.fmPhase * 6.283185307) * v.fmDepth * this.fmod
                v.fmPhase += v.freq * v.fmFreqMul * vibMod * invSR

                let sig = 0
                const np = v.numPartials
                for (let k = 0; k < np; k++) {
                    const pFreq = v.freq * v.freqMul[k] * vibMod * (1 + v.detuneAmt[k])
                    const phAdv = (pFreq + fmSig * v.freq) * invSR
                    sig += WAVEFNS[v.waveType[k]](v.phases[k]) * v.amps[k]
                    v.phases[k] += phAdv
                }

                const trem = 1 - (v.tremDepth * this.tremolo) * (0.5 + 0.5 * Math.sin(v.tremPhase * 6.283185307))
                v.tremPhase += v.tremRate * invSR

                const out = sig * v.gain * trem * this.volume
                outL[s] += out
                outR[s] += out
            }
        }
    }
}
