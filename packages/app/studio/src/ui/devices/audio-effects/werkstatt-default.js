// @param gain 1.0

class Processor {
    gain = 0
    paramChanged(label, value) {
        if (label === "gain") this.gain = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        for (let i = s0; i < s1; i++) {
            outL[i] = srcL[i] * this.gain
            outR[i] = srcR[i] * this.gain
        }
    }
}