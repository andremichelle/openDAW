import {float, int, nextPowOf2} from "@moises-ai/lib-std"
import {StereoMatrix} from "@moises-ai/lib-dsp"

// https://github.com/khoin/DattorroReverbNode
// https://ccrma.stanford.edu/~dattorro/EffectDesignPart1.pdf

export class DattorroReverbDsp {
    readonly #sampleRate: float
    readonly #delayBuffers: Float32Array[]
    readonly #delayLengths: Int32Array
    readonly #delayWrites: Int32Array
    readonly #delayReads: Int32Array
    readonly #delayMasks: Int32Array
    readonly #preDelayBuffer: Float32Array
    readonly #preDelayMask: int
    readonly #taps: Int16Array

    #preDelayWrite = 0 | 0
    #lp1 = 0.0
    #lp2 = 0.0
    #lp3 = 0.0
    #excPhase = 0.0
    #preDelay = 0
    #bandwidth = 0.9999
    #inputDiffusion1 = 0.75
    #inputDiffusion2 = 0.625
    #decay = 0.5
    #decayDiffusion1 = 0.7
    #decayDiffusion2 = 0.5
    #damping = 0.005
    #excursionRate = 0.5
    #excursionDepth = 0.7
    #wet = 0.3
    #dry = 0.6

    constructor(sampleRate: float) {
        this.#sampleRate = sampleRate
        const preDelaySize = nextPowOf2(sampleRate + 1)
        this.#preDelayBuffer = new Float32Array(preDelaySize)
        this.#preDelayMask = preDelaySize - 1
        const delayTimes = [
            0.004771345, 0.003595309, 0.012734787, 0.009307483,
            0.022579886, 0.149625349, 0.060481839, 0.1249958,
            0.030509727, 0.141695508, 0.089244313, 0.106280031
        ]
        const numDelays = delayTimes.length
        this.#delayBuffers = new Array(numDelays)
        this.#delayLengths = new Int32Array(numDelays)
        this.#delayWrites = new Int32Array(numDelays)
        this.#delayReads = new Int32Array(numDelays)
        this.#delayMasks = new Int32Array(numDelays)
        delayTimes.forEach((time, index) => {
            const len = Math.round(time * sampleRate)
            const size = nextPowOf2(len)
            this.#delayBuffers[index] = new Float32Array(size)
            this.#delayLengths[index] = len - 1
            this.#delayWrites[index] = len - 1
            this.#delayReads[index] = 0
            this.#delayMasks[index] = size - 1
        })
        const tapTimes = [
            0.008937872, 0.099929438, 0.064278754, 0.067067639, 0.066866033, 0.006283391, 0.035818689,
            0.011861161, 0.121870905, 0.041262054, 0.08981553, 0.070931756, 0.011256342, 0.004065724
        ]
        this.#taps = Int16Array.from(tapTimes, time => Math.round(time * sampleRate))
    }

    set preDelayMs(ms: float) {this.#preDelay = Math.floor((ms / 1000) * this.#sampleRate)}
    set bandwidth(value: float) {this.#bandwidth = value * 0.9999}
    set inputDiffusion1(value: float) {this.#inputDiffusion1 = value}
    set inputDiffusion2(value: float) {this.#inputDiffusion2 = value}
    set decay(value: float) {this.#decay = value}
    set decayDiffusion1(value: float) {this.#decayDiffusion1 = value * 0.999999}
    set decayDiffusion2(value: float) {this.#decayDiffusion2 = value * 0.999999}
    set damping(value: float) {this.#damping = value}
    set excursionRate(value: float) {this.#excursionRate = value * 2.0}
    set excursionDepth(value: float) {this.#excursionDepth = value * 2.0}
    set wetGain(value: float) {this.#wet = value}
    set dryGain(value: float) {this.#dry = value}

    reset(): void {
        this.#preDelayBuffer.fill(0)
        this.#delayBuffers.forEach(buffer => buffer.fill(0))
        this.#preDelayWrite = 0
        this.#lp1 = 0.0
        this.#lp2 = 0.0
        this.#lp3 = 0.0
        this.#excPhase = 0.0
    }

    process(input: StereoMatrix.Channels, output: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
        const pd = this.#preDelay
        const bw = this.#bandwidth
        const fi = this.#inputDiffusion1
        const si = this.#inputDiffusion2
        const dc = this.#decay
        const ft = this.#decayDiffusion1
        const st = this.#decayDiffusion2
        const dp = 1.0 - this.#damping
        const ex = this.#excursionRate / this.#sampleRate
        const ed = this.#excursionDepth * this.#sampleRate / 1000.0
        const we = this.#wet * 0.6
        const dr = this.#dry
        const inpChL = input[0]
        const inpChR = input[1]
        const outChL = output[0]
        const outChR = output[1]
        const pdBuf = this.#preDelayBuffer
        const pdMask = this.#preDelayMask
        const db = this.#delayBuffers
        const dw = this.#delayWrites
        const drd = this.#delayReads
        const dm = this.#delayMasks
        const taps = this.#taps
        const db0 = db[0], db1 = db[1], db2 = db[2], db3 = db[3]
        const db4 = db[4], db5 = db[5], db6 = db[6], db7 = db[7]
        const db8 = db[8], db9 = db[9], db10 = db[10], db11 = db[11]
        const dm0 = dm[0], dm1 = dm[1], dm2 = dm[2], dm3 = dm[3]
        const dm4 = dm[4], dm5 = dm[5], dm6 = dm[6], dm7 = dm[7]
        const dm8 = dm[8], dm9 = dm[9], dm10 = dm[10], dm11 = dm[11]
        let pdw = this.#preDelayWrite
        let lp1 = this.#lp1, lp2 = this.#lp2, lp3 = this.#lp3
        let excPhase = this.#excPhase
        for (let i = fromIndex; i < toIndex; i++) {
            const inpL = inpChL[i]
            const inpR = inpChR[i]
            pdBuf[pdw] = (inpL + inpR) * 0.5
            outChL[i] = inpL * dr
            outChR[i] = inpR * dr
            const delayedInput = pdBuf[(pdw - pd) & pdMask]
            lp1 += bw * (delayedInput - lp1)
            let pre = db0[dw[0]] = lp1 - fi * db0[drd[0]]
            pre = db1[dw[1]] = fi * (pre - db1[drd[1]]) + db0[drd[0]]
            pre = db2[dw[2]] = fi * pre + db1[drd[1]] - si * db2[drd[2]]
            pre = db3[dw[3]] = si * (pre - db3[drd[3]]) + db2[drd[2]]
            const split = si * pre + db3[drd[3]]
            const exc = ed * (1 + Math.cos(excPhase * 6.28))
            const exc2 = ed * (1 + Math.sin(excPhase * 6.2847))
            const r4exc = exc - ~~exc
            let r4int = ~~exc + drd[4] - 1
            const r4x0 = db4[r4int++ & dm4], r4x1 = db4[r4int++ & dm4]
            const r4x2 = db4[r4int++ & dm4], r4x3 = db4[r4int & dm4]
            const readC4 = (((3.0 * (r4x1 - r4x2) - r4x0 + r4x3) * 0.5 * r4exc
                + 2.0 * r4x2 + r4x0 - (5 * r4x1 + r4x3) * 0.5) * r4exc
                + (r4x2 - r4x0) * 0.5) * r4exc + r4x1
            let temp = db4[dw[4]] = split + dc * db11[drd[11]] + ft * readC4
            db5[dw[5]] = readC4 - ft * temp
            lp2 += dp * (db5[drd[5]] - lp2)
            temp = db6[dw[6]] = dc * lp2 - st * db6[drd[6]]
            db7[dw[7]] = db6[drd[6]] + st * temp
            const r8exc = exc2 - ~~exc2
            let r8int = ~~exc2 + drd[8] - 1
            const r8x0 = db8[r8int++ & dm8], r8x1 = db8[r8int++ & dm8]
            const r8x2 = db8[r8int++ & dm8], r8x3 = db8[r8int & dm8]
            const readC8 = (((3.0 * (r8x1 - r8x2) - r8x0 + r8x3) * 0.5 * r8exc
                + 2.0 * r8x2 + r8x0 - (5 * r8x1 + r8x3) * 0.5) * r8exc
                + (r8x2 - r8x0) * 0.5) * r8exc + r8x1
            temp = db8[dw[8]] = split + dc * db7[drd[7]] + ft * readC8
            db9[dw[9]] = readC8 - ft * temp
            lp3 += dp * (db9[drd[9]] - lp3)
            temp = db10[dw[10]] = dc * lp3 - st * db10[drd[10]]
            db11[dw[11]] = db10[drd[10]] + st * temp
            const lo = db9[(drd[9] + taps[0]) & dm9] + db9[(drd[9] + taps[1]) & dm9] -
                db10[(drd[10] + taps[2]) & dm10] + db11[(drd[11] + taps[3]) & dm11] -
                db5[(drd[5] + taps[4]) & dm5] - db6[(drd[6] + taps[5]) & dm6] -
                db7[(drd[7] + taps[6]) & dm7]
            const ro = db5[(drd[5] + taps[7]) & dm5] + db5[(drd[5] + taps[8]) & dm5] -
                db6[(drd[6] + taps[9]) & dm6] + db7[(drd[7] + taps[10]) & dm7] -
                db9[(drd[9] + taps[11]) & dm9] - db10[(drd[10] + taps[12]) & dm10] -
                db11[(drd[11] + taps[13]) & dm11]
            outChL[i] += lo * we
            outChR[i] += ro * we
            excPhase += ex
            pdw = (pdw + 1) & pdMask
            for (let d = 0; d < 12; d++) {
                dw[d] = (dw[d] + 1) & dm[d]
                drd[d] = (drd[d] + 1) & dm[d]
            }
        }
        this.#preDelayWrite = pdw
        this.#lp1 = lp1
        this.#lp2 = lp2
        this.#lp3 = lp3
        this.#excPhase = excPhase
    }
}
