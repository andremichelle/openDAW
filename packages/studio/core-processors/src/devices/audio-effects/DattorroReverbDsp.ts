import {float, int} from "@moises-ai/lib-std"
import {StereoMatrix} from "@moises-ai/lib-dsp"

// https://github.com/khoin/DattorroReverbNode
// https://ccrma.stanford.edu/~dattorro/EffectDesignPart1.pdf

export class DattorroReverbDsp {
    readonly #sampleRate: float
    readonly #delays: Array<[Float32Array, int, int, int]> = []
    readonly #preDelayBuffer: Float32Array
    readonly #taps: Int16Array
    readonly #preDelayLength: int

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
        this.#preDelayLength = sampleRate + 1 // one-second max
        this.#preDelayBuffer = new Float32Array(this.#preDelayLength)
        const delayTimes = [
            0.004771345, 0.003595309, 0.012734787, 0.009307483,
            0.022579886, 0.149625349, 0.060481839, 0.1249958,
            0.030509727, 0.141695508, 0.089244313, 0.106280031
        ]
        delayTimes.forEach(x => this.#makeDelay(x))
        const tapTimes = [
            0.008937872, 0.099929438, 0.064278754, 0.067067639, 0.066866033, 0.006283391, 0.035818689,
            0.011861161, 0.121870905, 0.041262054, 0.08981553, 0.070931756, 0.011256342, 0.004065724
        ]
        this.#taps = Int16Array.from(tapTimes, x => Math.round(x * sampleRate))
    }
    #makeDelay(length: float): void {
        const len = Math.round(length * this.#sampleRate)
        const nextPow2 = 2 ** Math.ceil(Math.log2(len))
        this.#delays.push([new Float32Array(nextPow2), len - 1, 0, nextPow2 - 1])
    }
    #writeDelay(index: int, data: float): float {
        return this.#delays[index][0][this.#delays[index][1]] = data
    }
    #readDelay(index: int): float {
        return this.#delays[index][0][this.#delays[index][2]]
    }
    #readDelayAt(index: int, offset: int): float {
        const d = this.#delays[index]
        return d[0][(d[2] + offset) & d[3]]
    }
    #readDelayCAt(index: int, offset: float): float {
        const d = this.#delays[index]
        const frac = offset - ~~offset
        let int = ~~offset + d[2] - 1
        const mask = d[3]
        const x0 = d[0][int++ & mask]
        const x1 = d[0][int++ & mask]
        const x2 = d[0][int++ & mask]
        const x3 = d[0][int & mask]
        const a = (3.0 * (x1 - x2) - x0 + x3) * 0.5
        const b = 2.0 * x2 + x0 - (5 * x1 + x3) * 0.5
        const c = (x2 - x0) * 0.5
        return (((a * frac) + b) * frac + c) * frac + x1
    }
    set preDelayMs(ms: float) {this.#preDelay = Math.floor((ms / 1000) * this.#sampleRate)}
    set bandwidth(value: float) { this.#bandwidth = value * 0.9999 }
    set inputDiffusion1(value: float) { this.#inputDiffusion1 = value }
    set inputDiffusion2(value: float) { this.#inputDiffusion2 = value }
    set decay(value: float) { this.#decay = value }
    set decayDiffusion1(value: float) { this.#decayDiffusion1 = value * 0.999999 }
    set decayDiffusion2(value: float) { this.#decayDiffusion2 = value * 0.999999 }
    set damping(value: float) { this.#damping = value }
    set excursionRate(value: float) { this.#excursionRate = value * 2.0 }
    set excursionDepth(value: float) { this.#excursionDepth = value * 2.0 }
    set wetGain(value: float) { this.#wet = value }
    set dryGain(value: float) { this.#dry = value }

    reset(): void {
        this.#preDelayBuffer.fill(0)
        this.#delays.forEach(d => d[0].fill(0))
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
        for (let i = fromIndex; i < toIndex; i++) {
            const inpL = inpChL[i]
            const inpR = inpChR[i]
            this.#preDelayBuffer[this.#preDelayWrite] = (inpL + inpR) * 0.5
            outChL[i] = inpL * dr
            outChR[i] = inpR * dr
            const delayedInput = this.#preDelayBuffer[(this.#preDelayLength + this.#preDelayWrite - pd) % this.#preDelayLength]
            this.#lp1 += bw * (delayedInput - this.#lp1)
            let pre = this.#writeDelay(0, this.#lp1 - fi * this.#readDelay(0))
            pre = this.#writeDelay(1, fi * (pre - this.#readDelay(1)) + this.#readDelay(0))
            pre = this.#writeDelay(2, fi * pre + this.#readDelay(1) - si * this.#readDelay(2))
            pre = this.#writeDelay(3, si * (pre - this.#readDelay(3)) + this.#readDelay(2))
            const split = si * pre + this.#readDelay(3)
            const exc = ed * (1 + Math.cos(this.#excPhase * 6.28))
            const exc2 = ed * (1 + Math.sin(this.#excPhase * 6.2847))
            let temp = this.#writeDelay(4, split + dc * this.#readDelay(11) + ft * this.#readDelayCAt(4, exc))
            this.#writeDelay(5, this.#readDelayCAt(4, exc) - ft * temp)
            this.#lp2 += dp * (this.#readDelay(5) - this.#lp2)
            temp = this.#writeDelay(6, dc * this.#lp2 - st * this.#readDelay(6))
            this.#writeDelay(7, this.#readDelay(6) + st * temp)
            temp = this.#writeDelay(8, split + dc * this.#readDelay(7) + ft * this.#readDelayCAt(8, exc2))
            this.#writeDelay(9, this.#readDelayCAt(8, exc2) - ft * temp)
            this.#lp3 += dp * (this.#readDelay(9) - this.#lp3)
            temp = this.#writeDelay(10, dc * this.#lp3 - st * this.#readDelay(10))
            this.#writeDelay(11, this.#readDelay(10) + st * temp)
            const lo = this.#readDelayAt(9, this.#taps[0]) + this.#readDelayAt(9, this.#taps[1]) -
                this.#readDelayAt(10, this.#taps[2]) + this.#readDelayAt(11, this.#taps[3]) -
                this.#readDelayAt(5, this.#taps[4]) - this.#readDelayAt(6, this.#taps[5]) -
                this.#readDelayAt(7, this.#taps[6])
            const ro = this.#readDelayAt(5, this.#taps[7]) + this.#readDelayAt(5, this.#taps[8]) -
                this.#readDelayAt(6, this.#taps[9]) + this.#readDelayAt(7, this.#taps[10]) -
                this.#readDelayAt(9, this.#taps[11]) - this.#readDelayAt(10, this.#taps[12]) -
                this.#readDelayAt(11, this.#taps[13])
            outChL[i] += lo * we
            outChR[i] += ro * we
            this.#excPhase += ex
            this.#preDelayWrite = (this.#preDelayWrite + 1) % this.#preDelayLength
            for (let i1 = 0; i1 < this.#delays.length; i1++) {
                const d = this.#delays[i1]
                d[1] = (d[1] + 1) & d[3]
                d[2] = (d[2] + 1) & d[3]
            }
        }
    }
}