// @apparat subcrusher 1 1
// @label SubCrusher Bass
// @param wave 0.3 0 1 linear
// @param cutoff 800 50 8000 exp Hz
// @param resonance 0.7 0.1 8 linear
// @param attack 0.005 0.001 0.2 exp s
// @param decay 0.15 0.01 1.0 exp s
// @param sustain 0.6 0 1 linear
// @param release 0.2 0.01 2.0 exp s
// @param drive 0.4 0 1 linear
// @param sub 0.5 0 1 linear
// @param glide 0.04 0 0.3 linear s

class Processor {
    // params
    wave = 0.3
    cutoff = 800
    resonance = 0.7
    attack = 0.005
    decay = 0.15
    sustain = 0.6
    release = 0.2
    drive = 0.4
    sub = 0.5
    glideTime = 0.04

    // voice state — mono bass, one active voice
    phase = 0
    subPhase = 0
    freq = 110
    targetFreq = 110
    glideRate = 0
    env = 0
    envState = "off" // "attack" "decay" "sustain" "release" "off"
    gate = false
    velocity = 0

    // filter state (one-pole lowpass + resonance feedback)
    fltL = 0; fltL1 = 0
    fltR = 0; fltR1 = 0

    // drive state (DC blocker)
    dcX1 = 0; dcY1 = 0

    paramChanged(name, value) {
        if (name === "wave") this.wave = value
        if (name === "cutoff") this.cutoff = value
        if (name === "resonance") this.resonance = value
        if (name === "attack") this.attack = value
        if (name === "decay") this.decay = value
        if (name === "sustain") this.sustain = value
        if (name === "release") this.release = value
        if (name === "drive") this.drive = value
        if (name === "sub") this.sub = value
        if (name === "glide") this.glideTime = value
    }

    noteOn(pitch, velocity, cent, id) {
        const newFreq = 440 * Math.pow(2, (pitch - 69) / 12 + cent / 1200)
        if (this.glideTime > 0 && this.envState !== "off") {
            this.targetFreq = newFreq
            this.glideRate = 1 / (this.glideTime * sampleRate)
        } else {
            this.freq = newFreq
            this.targetFreq = newFreq
            this.glideRate = 0
        }
        this.gate = true
        this.velocity = velocity
        this.envState = "attack"
    }

    noteOff(id) {
        this.gate = false
        this.envState = "release"
    }

    reset() {
        this.envState = "off"
        this.env = 0
        this.gate = false
        this.phase = 0
        this.subPhase = 0
        this.fltL = 0; this.fltL1 = 0
        this.fltR = 0; this.fltR1 = 0
    }

    // polynomial saw: 2x - 1 with BLEP-free truncation
    saw(phase) {
        return 2 * phase - 1
    }

    // square from saw comparison
    square(phase) {
        return phase < 0.5 ? 1 : -1
    }

    // mixed oscillator
    osc(phase) {
        const s = this.saw(phase)
        const q = this.square(phase)
        return s * (1 - this.wave) + q * this.wave
    }

    // tanh approx for drive
    softclip(x) {
        const d = 1 + this.drive * 4
        return x * d * 1.5 / (1 + 0.8 * x * x * d * d)
    }

    process(output, block) {
        const outL = output[0]
        const outR = output[1]
        const sr = sampleRate
        const wave = this.wave
        const sub = this.sub
        const driveAmt = this.drive
        const reso = this.resonance
        const subLevel = this.sub
        const cutoff = this.cutoff

        // envelope coefficients
        const attCoeff = 1 / (this.attack * sr)
        const decCoeff = 1 / (this.decay * sr)
        const relCoeff = 1 / (this.release * sr)
        const sustainLvl = this.sustain

        // filter coefficient — one-pole lowpass
        const wc = 2 * Math.PI * cutoff / sr
        const lpCoeff = Math.exp(-wc) // stable one-pole

        // DC blocker
        const dcC = 0.999

        for (let i = block.s0; i < block.s1; i++) {
            // glide
            // glide — exponential interpolation, works both up and down
            if (this.glideRate > 0 && this.freq !== this.targetFreq) {
                const logF = Math.log(this.freq)
                const logT = Math.log(this.targetFreq)
                const diff = logT - logF
                if (Math.abs(diff) < this.glideRate) {
                    this.freq = this.targetFreq
                    this.glideRate = 0
                } else {
                    this.freq = Math.exp(logF + Math.sign(diff) * this.glideRate)
                }
            }

            // oscillator phase
            const phaseInc = this.freq / sr
            this.phase += phaseInc
            if (this.phase >= 1) this.phase -= 1
            this.subPhase += phaseInc * 0.5 // sub one octave below
            if (this.subPhase >= 1) this.subPhase -= 1

            // oscillator
            let sample = this.osc(this.phase)

            // sub oscillator (sine one octave below)
            if (subLevel > 0) {
                const subWave = Math.sin(this.subPhase * 2 * Math.PI)
                sample += subWave * subLevel * 0.7
            }

            // envelope
            if (this.envState === "attack") {
                this.env += attCoeff
                if (this.env >= 1) {
                    this.env = 1
                    this.envState = "decay"
                }
            } else if (this.envState === "decay") {
                this.env -= decCoeff * (1 - sustainLvl)
                if (this.env <= sustainLvl) {
                    this.env = sustainLvl
                    this.envState = this.gate ? "sustain" : "release"
                }
            } else if (this.envState === "sustain") {
                this.env = sustainLvl
            } else if (this.envState === "release") {
                this.env -= relCoeff
                if (this.env <= 0) {
                    this.env = 0
                    this.envState = "off"
                }
            }

            // apply envelope
            sample *= this.env * this.velocity

            // resonant lowpass — one-pole with feedback
            const input = sample
            this.fltL = this.fltL + lpCoeff * (input - this.fltL + reso * (input - this.fltL))
            // clamp filter to prevent blowup
            if (this.fltL > 8) this.fltL = 8
            if (this.fltL < -8) this.fltL = -8
            let filtered = this.fltL

            // drive
            if (driveAmt > 0) {
                filtered = this.softclip(filtered)
            }

            // DC blocker
            this.dcY1 = dcC * (this.dcY1 + filtered - this.dcX1)
            this.dcX1 = filtered
            const out = this.dcY1

            // output (mono → stereo)
            outL[i] = out
            outR[i] = out
        }
    }
}
