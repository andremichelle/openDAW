// @label Ring Modulator
// @param frequency 440 20 2000 exp Hz

class Processor {
    phase = 0
    frequency = 440
    paramChanged(label, value) {
        if (label === "frequency") this.frequency = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const inc = this.frequency / sampleRate
        for (let i = s0; i < s1; i++) {
            const mod = Math.sin(this.phase * Math.PI * 2)
            this.phase += inc
            if (this.phase >= 1) this.phase -= 1
            outL[i] = srcL[i] * mod
            outR[i] = srcR[i] * mod
        }
    }
}