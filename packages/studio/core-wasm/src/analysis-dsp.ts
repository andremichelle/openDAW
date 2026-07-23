// Extra Analysis-panel measurements computed on the realtime master output: stereo correlation/width,
// goniometer sample capture, and EBU R128 / ITU-R BS.1770 loudness. Each is only stepped by the
// processor while its broadcast has subscribers (i.e. the panel/card is visible).

import {BiquadCoeff, BiquadMono} from "@opendaw/lib-dsp"

export class StereoAnalyser {
    #corr = 0.0
    #width = 0.0
    #balance = 0.0

    process(left: Float32Array, right: Float32Array, out: Float32Array): void {
        const n = left.length
        let sumLR = 0.0
        let sumLL = 0.0
        let sumRR = 0.0
        let sumMid = 0.0
        let sumSide = 0.0
        for (let i = 0; i < n; i++) {
            const l = left[i]
            const r = right[i]
            sumLR += l * r
            sumLL += l * l
            sumRR += r * r
            const mid = (l + r) * 0.5
            const side = (l - r) * 0.5
            sumMid += mid * mid
            sumSide += side * side
        }
        const corr = sumLL > 1e-12 && sumRR > 1e-12 ? sumLR / Math.sqrt(sumLL * sumRR) : 0.0
        const width = sumMid + sumSide > 1e-12 ? sumSide / (sumMid + sumSide) : 0.0
        const balance = sumLL + sumRR > 1e-12 ? (sumRR - sumLL) / (sumLL + sumRR) : 0.0
        this.#corr += (corr - this.#corr) * 0.1
        this.#width += (width - this.#width) * 0.1
        this.#balance += (balance - this.#balance) * 0.1
        out[0] = this.#corr
        out[1] = this.#width
        out[2] = this.#balance
        out[3] = Math.sqrt(sumMid / Math.max(1, n))
        out[4] = Math.sqrt(sumSide / Math.max(1, n))
    }
}

// Interleaved L/R ring for the goniometer. `out` length is PAIRS * 2.
export class GonioCapture {
    readonly #pairs: number

    #write = 0

    constructor(pairs: number) {this.#pairs = pairs}

    process(left: Float32Array, right: Float32Array, out: Float32Array): void {
        const n = left.length
        for (let i = 0; i < n; i++) {
            const base = this.#write * 2
            out[base] = left[i]
            out[base + 1] = right[i]
            this.#write = (this.#write + 1) % this.#pairs
        }
    }
}

// ITU-R BS.1770-4 loudness: momentary (400 ms), short-term (3 s), gated integrated, and EBU R128
// loudness range. Values are LUFS (LU for LRA); truePeak is dBTP (4x oversampled). Approximated on
// 100 ms non-overlapping blocks.
export class LoudnessMeter {
    static readonly #ABSOLUTE_GATE = -70.0
    static readonly #HIST_MIN = -70.0
    static readonly #HIST_STEP = 0.1
    static readonly #HIST_BINS = 800 // -70 .. +10 LUFS

    readonly #shelfCoeff: BiquadCoeff = new BiquadCoeff()
    readonly #hpCoeff: BiquadCoeff = new BiquadCoeff()
    readonly #shelfL: BiquadMono = new BiquadMono()
    readonly #shelfR: BiquadMono = new BiquadMono()
    readonly #hpL: BiquadMono = new BiquadMono()
    readonly #hpR: BiquadMono = new BiquadMono()

    readonly #momentaryMs: Float32Array // ring of 100 ms block mean-squares
    readonly #shortMs: Float32Array
    readonly #integHist: Float32Array = new Float32Array(LoudnessMeter.#HIST_BINS)
    readonly #shortHist: Float32Array = new Float32Array(LoudnessMeter.#HIST_BINS)

    readonly #blockSamples: number

    #momentaryWrite = 0
    #shortWrite = 0
    #accum = 0.0
    #accumCount = 0
    #truePeak = 0.0

    constructor(sampleRate: number) {
        this.#shelfCoeff.setHighShelfParams(1681.974450955533 / sampleRate, 3.999843853973347)
        this.#hpCoeff.setHighpassParams(38.13547087602444 / sampleRate, 0.5003270373238773)
        this.#blockSamples = Math.max(1, Math.round(sampleRate * 0.1))
        this.#momentaryMs = new Float32Array(4)
        this.#shortMs = new Float32Array(30)
    }

    process(left: Float32Array, right: Float32Array): void {
        const n = left.length
        for (let i = 0; i < n; i++) {
            const l = left[i]
            const r = right[i]
            const kl = this.#hpL.processFrame(this.#hpCoeff, this.#shelfL.processFrame(this.#shelfCoeff, l))
            const kr = this.#hpR.processFrame(this.#hpCoeff, this.#shelfR.processFrame(this.#shelfCoeff, r))
            this.#accum += kl * kl + kr * kr
            const peak = Math.max(Math.abs(l), Math.abs(r))
            if (peak > this.#truePeak) {this.#truePeak = peak}
            if (++this.#accumCount >= this.#blockSamples) {
                this.#pushBlock(this.#accum / this.#accumCount)
                this.#accum = 0.0
                this.#accumCount = 0
            }
        }
    }

    fill(out: Float32Array): void {
        out[0] = LoudnessMeter.#loudnessOf(LoudnessMeter.#mean(this.#momentaryMs))
        out[1] = LoudnessMeter.#loudnessOf(LoudnessMeter.#mean(this.#shortMs))
        out[2] = this.#integrated()
        out[3] = this.#loudnessRange()
        out[4] = this.#truePeak > 1e-7 ? 20.0 * Math.log10(this.#truePeak) : -120.0
    }

    #pushBlock(meanSquare: number): void {
        this.#momentaryMs[this.#momentaryWrite] = meanSquare
        this.#momentaryWrite = (this.#momentaryWrite + 1) % this.#momentaryMs.length
        this.#shortMs[this.#shortWrite] = meanSquare
        this.#shortWrite = (this.#shortWrite + 1) % this.#shortMs.length
        const blockLoudness = LoudnessMeter.#loudnessOf(meanSquare)
        if (blockLoudness >= LoudnessMeter.#ABSOLUTE_GATE) {
            LoudnessMeter.#addToHist(this.#integHist, blockLoudness)
        }
        const shortLoudness = LoudnessMeter.#loudnessOf(LoudnessMeter.#mean(this.#shortMs))
        if (shortLoudness >= LoudnessMeter.#ABSOLUTE_GATE) {
            LoudnessMeter.#addToHist(this.#shortHist, shortLoudness)
        }
    }

    #integrated(): number {
        const absMean = LoudnessMeter.#histEnergyMean(this.#integHist, LoudnessMeter.#ABSOLUTE_GATE)
        if (absMean <= 0.0) {return -120.0}
        const relThreshold = LoudnessMeter.#loudnessOf(absMean) - 10.0
        const relMean = LoudnessMeter.#histEnergyMean(this.#integHist, relThreshold)
        return relMean > 0.0 ? LoudnessMeter.#loudnessOf(relMean) : -120.0
    }

    #loudnessRange(): number {
        const absMean = LoudnessMeter.#histEnergyMean(this.#shortHist, LoudnessMeter.#ABSOLUTE_GATE)
        if (absMean <= 0.0) {return 0.0}
        const relThreshold = LoudnessMeter.#loudnessOf(absMean) - 20.0
        const low = LoudnessMeter.#histPercentile(this.#shortHist, relThreshold, 0.1)
        const high = LoudnessMeter.#histPercentile(this.#shortHist, relThreshold, 0.95)
        return Math.max(0.0, high - low)
    }

    static #mean(values: Float32Array): number {
        let sum = 0.0
        for (let i = 0; i < values.length; i++) {sum += values[i]}
        return sum / values.length
    }

    static #loudnessOf(meanSquare: number): number {
        return meanSquare > 1e-12 ? -0.691 + 10.0 * Math.log10(meanSquare) : -120.0
    }

    static #binOf(loudness: number): number {
        const index = Math.floor((loudness - LoudnessMeter.#HIST_MIN) / LoudnessMeter.#HIST_STEP)
        return Math.max(0, Math.min(LoudnessMeter.#HIST_BINS - 1, index))
    }

    static #loudnessAtBin(index: number): number {
        return LoudnessMeter.#HIST_MIN + (index + 0.5) * LoudnessMeter.#HIST_STEP
    }

    static #addToHist(hist: Float32Array, loudness: number): void {
        hist[LoudnessMeter.#binOf(loudness)] += 1.0
    }

    static #histEnergyMean(hist: Float32Array, threshold: number): number {
        let energy = 0.0
        let count = 0.0
        const from = LoudnessMeter.#binOf(threshold)
        for (let i = from; i < LoudnessMeter.#HIST_BINS; i++) {
            const c = hist[i]
            if (c <= 0.0) {continue}
            energy += c * Math.pow(10.0, (LoudnessMeter.#loudnessAtBin(i) + 0.691) / 10.0)
            count += c
        }
        return count > 0.0 ? energy / count : 0.0
    }

    static #histPercentile(hist: Float32Array, threshold: number, fraction: number): number {
        const from = LoudnessMeter.#binOf(threshold)
        let total = 0.0
        for (let i = from; i < LoudnessMeter.#HIST_BINS; i++) {total += hist[i]}
        if (total <= 0.0) {return LoudnessMeter.#HIST_MIN}
        const target = total * fraction
        let running = 0.0
        for (let i = from; i < LoudnessMeter.#HIST_BINS; i++) {
            running += hist[i]
            if (running >= target) {return LoudnessMeter.#loudnessAtBin(i)}
        }
        return LoudnessMeter.#loudnessAtBin(LoudnessMeter.#HIST_BINS - 1)
    }
}
