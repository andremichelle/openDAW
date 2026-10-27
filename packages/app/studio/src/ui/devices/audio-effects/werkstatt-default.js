class Processor {
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        for (let i = s0; i < s1; i++) {
            outL[i] = srcL[i]
            outR[i] = srcR[i]
        }
    }
}