// @label Hard Clipper
// @param threshold 0.5 0.1 1.0 linear
// @param soft false

class Processor {
    threshold = 0.5
    soft = 0
    paramChanged(label, value) {
        if (label === "threshold") this.threshold = value
        if (label === "soft") this.soft = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const t = this.threshold
        if (this.soft) {
            for (let i = s0; i < s1; i++) {
                outL[i] = Math.tanh(srcL[i] / t) * t
                outR[i] = Math.tanh(srcR[i] / t) * t
            }
        } else {
            for (let i = s0; i < s1; i++) {
                outL[i] = Math.max(-t, Math.min(t, srcL[i]))
                outR[i] = Math.max(-t, Math.min(t, srcR[i]))
            }
        }
    }
}