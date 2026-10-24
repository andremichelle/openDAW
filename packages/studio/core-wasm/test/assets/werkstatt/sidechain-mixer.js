// @label Sidechain Mixer
// @param input 1 0 1 linear
// @group A orange
// @sidechain A
// @param gainA 1 0 1 linear
// @group B orange
// @sidechain B
// @param gainB 1 0 1 linear

class Processor {
    gains = {input: 1, gainA: 1, gainB: 1}
    paramChanged(label, value) {
        this.gains[label] = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const [aL, aR] = this.sidechains.A
        const [bL, bR] = this.sidechains.B
        const {input, gainA, gainB} = this.gains
        for (let i = s0; i < s1; i++) {
            outL[i] = srcL[i] * input + aL[i] * gainA + bL[i] * gainB
            outR[i] = srcR[i] * input + aR[i] * gainA + bR[i] * gainB
        }
    }
}
