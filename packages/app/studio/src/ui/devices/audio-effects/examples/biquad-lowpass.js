// Biquad Lowpass
// @param cutoff 0.5
// @param resonance 0.5

class Processor {
    x1L = 0; x2L = 0; y1L = 0; y2L = 0
    x1R = 0; x2R = 0; y1R = 0; y2R = 0
    b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0
    cutoff = 1000; resonance = 0.707
    paramChanged(label, value) {
        if (label === "cutoff") this.cutoff = 20 + value * 19980
        if (label === "resonance") this.resonance = 0.1 + value * 9.9
        this.recalcCoefficients(this.cutoff, this.resonance)
    }
    recalcCoefficients(cutoff, resonance) {
        const w0 = 2 * Math.PI * cutoff / sampleRate
        const alpha = Math.sin(w0) / (2 * resonance)
        const cosw0 = Math.cos(w0)
        const a0 = 1 + alpha
        this.b0 = ((1 - cosw0) / 2) / a0
        this.b1 = (1 - cosw0) / a0
        this.b2 = this.b0
        this.a1 = (-2 * cosw0) / a0
        this.a2 = (1 - alpha) / a0
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        for (let i = s0; i < s1; i++) {
            const oL = this.b0 * srcL[i] + this.b1 * this.x1L + this.b2 * this.x2L
                - this.a1 * this.y1L - this.a2 * this.y2L
            this.x2L = this.x1L; this.x1L = srcL[i]
            this.y2L = this.y1L; this.y1L = oL
            outL[i] = oL
            const oR = this.b0 * srcR[i] + this.b1 * this.x1R + this.b2 * this.x2R
                - this.a1 * this.y1R - this.a2 * this.y2R
            this.x2R = this.x1R; this.x1R = srcR[i]
            this.y2R = this.y1R; this.y1R = oR
            outR[i] = oR
        }
    }
}