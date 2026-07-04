// @werkstatt ringmodenv 1 1
// Ring modulator with envelope-followed frequency modulation
// Issue #277: MIDI-triggered ADSR for Werkstatt — workaround using input-driven envelope
// Since Werkstatt is an audio effect (not an instrument), it has no noteOn/noteOff.
// This script uses the input signal amplitude to trigger an ADSR-style envelope
// that modulates the ring modulator frequency, simulating MIDI-driven behavior.
// Route a drum track or rhythmic audio into the Werkstatt to "trigger" the envelope.

// @param freq       440 20 2000 exp Hz    // base carrier frequency
// @param modDepth   0.5 0 1 linear %     // envelope→frequency modulation depth
// @param modRange   2.0 0.5 8 linear x   // frequency multiplier range (octaves)
// @param attack     0.3 0 1 linear %     // attack speed (0=slow, 1=fast)
// @param release    0.2 0 1 linear %     // release speed (0=slow, 1=fast)
// @param threshold  0.02 0 0.5 linear %  // trigger threshold (silence = no modulation)
// @param mix        0.5 0 1 linear %     // dry/wet mix
// @param output     0.5 0 1 linear %     // output gain (0=-12dB, 0.5=0dB, 1=+12dB)

class Processor {
    phase = 0
    freq = 440
    modDepth = 0.5
    modRange = 2.0
    attack = 0.3
    release = 0.2
    threshold = 0.02
    mix = 0.5
    output = 0.5
    env = 0
    envState = 0  // 0=idle, 1=attack, 2=release

    paramChanged(label, value) {
        if (label === "freq") this.freq = value
        else if (label === "modDepth") this.modDepth = value
        else if (label === "modRange") this.modRange = value
        else if (label === "attack") this.attack = value
        else if (label === "release") this.release = value
        else if (label === "threshold") this.threshold = value
        else if (label === "mix") this.mix = value
        else if (label === "output") this.output = value
    }

    process(io, block) {
        const sr = globalThis.sampleRate || 44100
        const srcL = io.src[0]
        const srcR = io.src[1] || io.src[0]
        const outL = io.out[0]
        const outR = io.out[1] || io.out[0]
        const len = block.s1 - block.s0

        // attack: 0→200ms, 1→0.5ms
        const aMs = 200 * Math.pow(0.0025, this.attack)
        const rMs = 800 * Math.pow(0.00125, this.release)
        const aCoeff = Math.exp(-1 / (sr * aMs * 0.001))
        const rCoeff = Math.exp(-1 / (sr * rMs * 0.001))

        const threshLin = this.threshold * this.threshold
        // output gain: 0→0.25, 0.5→1, 1→4
        const outGain = Math.pow(4, (this.output - 0.5) * 2)
        const dryMix = 1 - this.mix
        const wetMix = this.mix

        for (let i = 0; i < len; i++) {
            const idx = block.s0 + i
            const inp = (srcL[idx] + (srcR === srcL ? srcL[idx] : srcR[idx])) * 0.5
            const absInp = inp < 0 ? -inp : inp

            // Transient detection → trigger ADSR
            if (absInp > threshLin) {
                this.envState = 1  // attack
            }

            // ADSR: attack phase rises, release phase decays
            if (this.envState === 1) {
                this.env = aCoeff * this.env + (1 - aCoeff) * 1.0
                if (this.env > 0.99) this.envState = 2  // → release
            } else if (this.envState === 2) {
                this.env = rCoeff * this.env
                if (this.env < 0.001) {
                    this.env = 0
                    this.envState = 0
                }
            }

            // Modulate frequency: env 0→1 maps freq to freq*modRange
            const modFreq = this.freq * (1 + this.modDepth * this.env * (this.modRange - 1))
            const inc = modFreq / sr

            // Ring modulation: sine carrier × input
            const carrier = Math.sin(this.phase * Math.PI * 2)
            this.phase += inc
            if (this.phase >= 1) this.phase -= 1

            const wet = inp * carrier
            outL[idx] = (srcL[idx] * dryMix + wet * wetMix) * outGain
            if (outR !== outL) {
                outR[idx] = (srcR[idx] * dryMix + wet * wetMix) * outGain
            }
        }
    }
}
