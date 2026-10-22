// @label Sidechain Ducker
// @sidechain Key
// @param depth 0.8 0 1 linear
// @param release 0.15 0.01 1 exp s

class Processor {
    envelope = 0
    depth = 0.8
    release = 0.15
    paramChanged(label, value) {
        if (label === "depth") this.depth = value
        if (label === "release") this.release = value
    }
    reset() {
        this.envelope = 0
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const [keyL, keyR] = this.sidechains.Key
        const fall = Math.exp(-1 / (this.release * sampleRate))
        for (let i = s0; i < s1; i++) {
            const level = Math.max(Math.abs(keyL[i]), Math.abs(keyR[i]))
            this.envelope = level > this.envelope ? level : this.envelope * fall
            const gain = 1 - this.depth * Math.min(1, this.envelope)
            outL[i] = srcL[i] * gain
            outR[i] = srcR[i] * gain
        }
    }
}
