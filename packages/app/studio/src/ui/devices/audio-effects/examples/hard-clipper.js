// Hard Clipper
class Processor {
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        for (let i = s0; i < s1; i++) {
            outL[i] = Math.max(-0.5, Math.min(0.5, srcL[i]))
            outR[i] = Math.max(-0.5, Math.min(0.5, srcR[i]))
        }
    }
}