import {AudioData} from "./audio-data"
import {BiquadCoeff} from "./biquad-coeff"
import {BiquadMono} from "./biquad-processor"
import {panic} from "@moises-ai/lib-std"

const LR_ORDER = 48
const LOW_CROSSOVER_HZ = 200.0
const HIGH_CROSSOVER_HZ = 2000.0
const RMS_WINDOW_MS = 20.0
const MIN_TRANSIENT_COUNT = 2
const ENERGY_DERIVATIVE_THRESHOLD = 0.0003
const MAX_TRANSIENT_DENSITY_PER_SEC = 40.0
const MIN_TRANSIENT_SEPARATION_MS = 120.0
const VALLEY_BIAS = 0.2
const MAX_VALLEY_SEARCH_MS = 20.0
const ONSET_ENERGY_RATIO = 0.66
const VALLEY_RMS = 0.006

const BAND_WEIGHTS: Record<Band, number> = {
    low: 1.0,
    mid: 4.0,
    high: 8.0
}

type Band = "low" | "mid" | "high"

type BandBuffers = {
    low: Float32Array
    mid: Float32Array
    high: Float32Array
}

type Onset = {
    position: number
    energy: number
}

export class TransientDetector {
    static detect(audio: AudioData): number[] {
        const now = performance.now()
        const duration = audio.numberOfFrames / audio.sampleRate
        const result = new TransientDetector(audio).#detect()
        const took = (((performance.now() - now) / 1000.0) / duration * 100.0).toFixed(2)
        console.debug(`realtime factor: ${took}%`)
        return result
    }

    readonly #sampleRate: number
    readonly #numberOfFrames: number
    readonly #maxValleySearchSamples: number
    readonly #minSeparationSamples: number
    readonly #windowSamples: number
    readonly #halfWindow: number
    readonly #maxCount: number
    readonly #mono: Float32Array

    constructor(audio: AudioData) {
        this.#sampleRate = audio.sampleRate
        this.#numberOfFrames = audio.numberOfFrames
        this.#maxValleySearchSamples = Math.floor((MAX_VALLEY_SEARCH_MS / 1000.0) * this.#sampleRate)
        this.#minSeparationSamples = Math.floor((MIN_TRANSIENT_SEPARATION_MS / 1000.0) * this.#sampleRate)
        this.#windowSamples = Math.floor((RMS_WINDOW_MS / 1000.0) * this.#sampleRate)
        this.#halfWindow = Math.floor(this.#windowSamples / 2)
        const durationSeconds = this.#numberOfFrames / this.#sampleRate
        this.#maxCount = Math.floor(durationSeconds * MAX_TRANSIENT_DENSITY_PER_SEC)
        this.#mono = this.#mixToMono(audio)
    }

    #detect(): number[] {
        // Phase 1: Collect rough candidates from all bands
        const candidates = this.#collectCandidates()
        // Phase 2: Refine each candidate to the valley between it and previous
        const refined = this.#refineToValleys(candidates)
        return refined.map(x => x / this.#sampleRate)
    }

    #collectCandidates(): number[] {
        const bands = this.#splitBands()
        const allOnsets: Onset[] = []
        for (const band of ["low", "mid", "high"] as Band[]) {
            const buffer = bands[band]
            const envelope = this.#computeEnergyEnvelope(buffer)
            const onsets = this.#detectOnsets(envelope)
            const weight = BAND_WEIGHTS[band]
            for (const onset of onsets) {
                allOnsets.push({position: onset.position, energy: onset.energy * weight})
            }
        }
        // Sort by energy descending and greedily collect respecting minimum separation
        const collected: number[] = [0, this.#numberOfFrames]
        const sorted = [...allOnsets].sort((a, b) => b.energy - a.energy)
        for (const onset of sorted) {
            if (collected.length >= this.#maxCount + 2 && collected.length >= MIN_TRANSIENT_COUNT + 2) {
                break
            }
            if (!this.#isTooClose(collected, onset.position)) {
                this.#insertSorted(collected, onset.position)
            }
        }
        return collected
    }

    #refineToValleys(candidates: number[]): number[] {
        if (candidates.length < 2) {return candidates}
        const refined: number[] = [candidates[0]]
        const rmsWindow = Math.floor(this.#sampleRate * VALLEY_RMS)
        for (let i = 1; i < candidates.length - 1; i++) {
            const prev = candidates[i - 1]
            const curr = candidates[i]
            if (prev === 0) {
                refined.push(curr)
                continue
            }
            const gap = curr - prev
            const gapBasedStart = prev + Math.floor(gap * VALLEY_BIAS)
            const windowBasedStart = curr - this.#maxValleySearchSamples
            const searchStart = Math.max(gapBasedStart, windowBasedStart)
            // Compute RMS at candidate position (the transient energy)
            let candidateRms = 0.0
            for (let k = 0; k < rmsWindow && curr + k < this.#numberOfFrames; k++) {
                candidateRms += this.#mono[curr + k] * this.#mono[curr + k]
            }
            candidateRms = Math.sqrt(candidateRms / rmsWindow)
            const thresoldEnergy = candidateRms * ONSET_ENERGY_RATIO
            let minRms = Infinity
            let minPos = curr
            for (let j = curr - 1; j >= searchStart; j--) {
                let sum = 0.0
                for (let k = 0; k < rmsWindow && j + k < this.#numberOfFrames; k++) {
                    sum += this.#mono[j + k] * this.#mono[j + k]
                }
                const rms = Math.sqrt(sum / rmsWindow)
                if (rms < minRms) {
                    minRms = rms
                    minPos = j
                }
                if (rms < thresoldEnergy) {
                    break
                }
            }
            refined.push(minPos)
        }
        refined.push(candidates[candidates.length - 1])
        return refined
    }

    #mixToMono(audio: AudioData): Float32Array {
        const {numberOfFrames, numberOfChannels, frames} = audio
        if (numberOfChannels === 0) {return panic("Invalid sample. No channels found.")}
        if (numberOfChannels === 1) {return new Float32Array(frames[0])}
        const mono = new Float32Array(numberOfFrames)
        for (let ch = 0; ch < numberOfChannels; ch++) {
            const channel = frames[ch]
            for (let i = 0; i < numberOfFrames; i++) {
                mono[i] += channel[i]
            }
        }
        const scale = 1.0 / numberOfChannels
        for (let i = 0; i < numberOfFrames; i++) {
            mono[i] *= scale
        }
        return mono
    }

    #applyLRFilter(input: Float32Array, freq: number, type: "lowpass" | "highpass", order: number): Float32Array {
        const passes = order / 12
        const coeff = new BiquadCoeff()
        const cutoff = freq / this.#sampleRate
        if (type === "lowpass") {
            coeff.setLowpassParams(cutoff, Math.SQRT1_2)
        } else {
            coeff.setHighpassParams(cutoff, Math.SQRT1_2)
        }
        let result = input
        for (let p = 0; p < passes; p++) {
            const filter1 = new BiquadMono()
            const filter2 = new BiquadMono()
            const temp1 = new Float32Array(result.length)
            const temp2 = new Float32Array(result.length)
            filter1.process(coeff, result, temp1, 0, result.length)
            filter2.process(coeff, temp1, temp2, 0, result.length)
            result = temp2
        }
        return result
    }

    #splitBands(): BandBuffers {
        const low = this.#applyLRFilter(this.#mono, LOW_CROSSOVER_HZ, "lowpass", LR_ORDER)
        const highFromLow = this.#applyLRFilter(this.#mono, LOW_CROSSOVER_HZ, "highpass", LR_ORDER)
        const mid = this.#applyLRFilter(highFromLow, HIGH_CROSSOVER_HZ, "lowpass", LR_ORDER)
        const high = this.#applyLRFilter(highFromLow, HIGH_CROSSOVER_HZ, "highpass", LR_ORDER)
        return {low, mid, high}
    }

    #computeEnergyEnvelope(buffer: Float32Array): Float32Array {
        const envelope = new Float32Array(buffer.length)
        let sumSq = 0.0
        for (let i = 0; i < this.#windowSamples && i < buffer.length; i++) {
            sumSq += buffer[i] * buffer[i]
        }
        for (let i = 0; i < buffer.length; i++) {
            const windowStart = i - this.#halfWindow
            const windowEnd = i + this.#halfWindow
            if (windowStart > 0 && windowStart - 1 < buffer.length) {
                const old = buffer[windowStart - 1]
                sumSq -= old * old
            }
            if (windowEnd < buffer.length) {
                const next = buffer[windowEnd]
                sumSq += next * next
            }
            const count = Math.min(windowEnd, buffer.length - 1) - Math.max(windowStart, 0) + 1
            envelope[i] = Math.sqrt(Math.max(0.0, sumSq) / count)
        }
        return envelope
    }

    #detectOnsets(envelope: Float32Array): Onset[] {
        let maxEnergy = 0.0
        for (let i = 0; i < envelope.length; i++) {
            if (envelope[i] > maxEnergy) {maxEnergy = envelope[i]}
        }
        const threshold = maxEnergy * ENERGY_DERIVATIVE_THRESHOLD
        const onsets: Onset[] = []
        for (let i = 1; i < envelope.length - 1; i++) {
            const derivative = envelope[i] - envelope[i - 1]
            const nextDerivative = envelope[i + 1] - envelope[i]
            if (derivative > threshold && derivative > nextDerivative) {
                onsets.push({position: i, energy: envelope[i]})
            }
        }
        return onsets
    }

    #isTooClose(arr: number[], position: number): boolean {
        const idx = this.#binarySearchInsertPosition(arr, position)
        if (idx > 0 && position - arr[idx - 1] < this.#minSeparationSamples) {
            return true
        }
        return idx < arr.length && arr[idx] - position < this.#minSeparationSamples
    }

    #insertSorted(arr: number[], value: number): void {
        const idx = this.#binarySearchInsertPosition(arr, value)
        arr.splice(idx, 0, value)
    }

    #binarySearchInsertPosition(arr: number[], value: number): number {
        let lo = 0
        let hi = arr.length
        while (lo < hi) {
            const mid = (lo + hi) >>> 1
            if (arr[mid] < value) {
                lo = mid + 1
            } else {
                hi = mid
            }
        }
        return lo
    }
}