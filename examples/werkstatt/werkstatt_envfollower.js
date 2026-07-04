// @werkstatt envfollower 1 1
// Envelope follower — tracks input amplitude and applies as gain modulation
// Issue #139: parameter modulation controllers
// Use as sidechain-like effect: input amplitude controls output gain

// @param attack   0.5 0 1 linear %   // attack speed (0=slow, 1=fast)
// @param release  0.2 0 1 linear %   // release speed (0=slow, 1=fast)
// @param depth    0.8 0 1 linear %   // modulation depth (0=bypass, 1=full)
// @param threshold 0.0 0 1 linear %  // gate threshold (0=open, 1=closed)
// @param invert   1.0 0 1 linear %   // invert modulation (ducking vs boosting)
// @param makeup   0.5 0 1 linear %   // output makeup gain (0=-12dB, 1=+12dB)

class Processor {
    attack = 0.5
    release = 0.2
    depth = 0.8
    threshold = 0.0
    invert = 1.0    // default: ducking (expander behavior)
    makeup = 0.5
    env = 0         // current envelope value
    sRate = 44100

    paramChanged(label, value) {
        if (label === "attack") this.attack = value
        else if (label === "release") this.release = value
        else if (label === "depth") this.depth = value
        else if (label === "threshold") this.threshold = value
        else if (label === "invert") this.invert = value
        else if (label === "makeup") this.makeup = value
    }

    process(io, block) {
        const sr = globalThis.sampleRate || 44100
        const srcL = io.src[0]
        const srcR = io.src[1] || io.src[0]
        const outL = io.out[0]
        const outR = io.out[1] || io.out[0]
        const len = outL.length

        // Convert params to coefficients
        // attack 0→500ms, 1→0.5ms
        const attackMs = 500 * Math.pow(0.001, this.attack)
        const releaseMs = 2000 * Math.pow(0.001, this.release)
        const aCoeff = Math.exp(-1 / (sr * attackMs * 0.001))
        const rCoeff = Math.exp(-1 / (sr * releaseMs * 0.001))

        // Threshold in linear amplitude
        const threshLin = this.threshold * this.threshold

        // Makeup gain: 0→0.25 (-12dB), 0.5→1 (0dB), 1→4 (+12dB)
        const makeupGain = Math.pow(4, (this.makeup - 0.5) * 2)

        for (let i = 0; i < len; i++) {
            // Get input amplitude (mono sum)
            const inp = (srcL[i] + srcR[i]) * 0.5
            const absInp = inp < 0 ? -inp : inp

            // Envelope follower: fast attack, slow release
            if (absInp > this.env) {
                this.env = aCoeff * this.env + (1 - aCoeff) * absInp
            } else {
                this.env = rCoeff * this.env + (1 - rCoeff) * absInp
            }

            // Gate: if envelope below threshold, reduce modulation
            let modSig = this.env
            if (this.env < threshLin) modSig = 0

            // Modulation signal: 0..1
            // Normalize (soft clip at 1)
            let modNorm = modSig
            if (modNorm > 1) modNorm = 1

            // Invert: 0 → normal (boost on loud), 1 → inverted (duck on loud)
            const invFactor = this.invert
            let gain
            if (invFactor > 0.5) {
                // Ducking: loud input → quiet output
                gain = 1 - this.depth * modNorm
            } else {
                // Boosting: loud input → louder output
                gain = 1 + this.depth * modNorm
            }

            // Apply gain + makeup
            const finalGain = gain * makeupGain
            outL[i] = srcL[i] * finalGain
            outR[i] = (srcR === srcL ? srcL[i] : srcR[i]) * finalGain
        }
    }
}
