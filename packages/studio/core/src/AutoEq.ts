import {clamp} from "@opendaw/lib-std"
import {AudioData, BiquadCoeff, FFT, Window} from "@opendaw/lib-dsp"

// Auto-EQ analysis: derive a gentle, gain-neutral corrective EQ from a rendered mixdown. The measured
// spectrum is energy-per-1/6-octave (pink reads flat), so equal-energy content reads at equal level
// regardless of frequency. The correction target is the gain-neutral difference between a reference slope
// (pink at tilt 0) and the measured curve, so a mix already on the reference needs nothing. The five Revamp
// sections (two shelves + three bells) are fitted by least squares so their combined response matches that
// target; because it accounts for their overlapping skirts and the reference is fixed, a re-analysis of the
// corrected mix converges to almost no further change.
export namespace AutoEq {
    export type Band = { frequency: number, gainDb: number }
    export type Result = {
        lowShelf: Band
        lowBell: Band
        midBell: Band
        highBell: Band
        highShelf: Band
    }
    export type Options = {
        // optional overall brighten (+) / darken (-) tilt in dB per octave, applied on top of the
        // resonance correction. 0 preserves the mix's own tonal balance.
        tiltDbPerOctave?: number
        // clamp per section, keeping the correction gentle (Revamp itself allows +/-24 dB).
        maxGainDb?: number
    }

    const LOW_SHELF_FREQUENCY = 100.0
    const HIGH_SHELF_FREQUENCY = 9000.0
    const BELL_DEFAULT_FREQUENCIES: ReadonlyArray<number> = [300.0, 1000.0, 3500.0]
    const BELL_MIN_FREQUENCY = 150.0 // bells stay interior; the two shelves own the extremes
    const BELL_MAX_FREQUENCY = 7000.0
    const BELL_MIN_SPACING = 1.0 // octaves between chosen bell centres so they target distinct features
    const FFT_SIZE = 4096
    const SILENCE_RMS = 1.0e-3 // ~ -60 dBFS: frames below this do not bias the average toward the noise floor
    const PROBES = 60
    // Musical core only: outside this range the measurement and real content are unreliable and the shelves
    // over-react, so the fit is confined to it (both shelf centres sit well inside).
    const MIN_FREQUENCY = 35.0
    const MAX_FREQUENCY = 16000.0
    const HALF_OCTAVE = Math.pow(2.0, 1.0 / 6.0) // 1/6-octave measurement window each side
    const BELL_Q = Math.SQRT1_2 // matches the Q AutoEqAction writes into the bells
    const FIT_ITERATIONS = 4 // Gauss-Newton passes re-linearizing each band's response at its fitted gain
    const MAKEUP_ITERATIONS = 4 // passes driving the realized loudness change to zero (level-neutral EQ)
    const RIDGE = 0.05 // regularization keeping the least-squares gains modest and well-conditioned

    // Neutral: preserve the mix's own tonal balance and only tame resonances/dips. Positive brightens.
    export const DEFAULT_TILT_DB_PER_OCTAVE = 0.0
    // Gentle per-section clamp: keeps a first pass a nudge, not surgery. Raise for a stronger correction.
    export const DEFAULT_MAX_GAIN_DB = 4.5

    export const analyze = (audio: AudioData, options: Options = {}): Result => {
        const tilt = options.tiltDbPerOctave ?? DEFAULT_TILT_DB_PER_OCTAVE
        const maxGain = options.maxGainDb ?? DEFAULT_MAX_GAIN_DB
        const {sampleRate, numberOfFrames, frames} = audio
        const left = frames[0]
        const right = frames[1] ?? frames[0]
        const half = FFT_SIZE >> 1
        const hop = FFT_SIZE >> 1
        const window = Window.create(Window.Type.Hanning, FFT_SIZE)
        const fft = new FFT(FFT_SIZE)
        const real = new Float32Array(FFT_SIZE)
        const imag = new Float32Array(FFT_SIZE)
        const power = new Float64Array(half)
        let frameCount = 0
        for (let start = 0; start + FFT_SIZE <= numberOfFrames; start += hop) {
            let sumSquares = 0.0
            for (let i = 0; i < FFT_SIZE; i++) {
                const mono = (left[start + i] + right[start + i]) * 0.5
                real[i] = mono
                imag[i] = 0.0
                sumSquares += mono * mono
            }
            if (Math.sqrt(sumSquares / FFT_SIZE) < SILENCE_RMS) {continue}
            for (let i = 0; i < FFT_SIZE; i++) {real[i] *= window[i]}
            fft.process(real, imag)
            for (let i = 1; i < half; i++) {power[i] += real[i] * real[i] + imag[i] * imag[i]}
            frameCount++
        }
        if (frameCount === 0) {return flat()} // a silent project needs no correction
        for (let i = 1; i < half; i++) {power[i] /= frameCount}
        const measuredAt = (frequency: number): number => {
            const lowBin = Math.max(1, Math.floor(frequency / HALF_OCTAVE * FFT_SIZE / sampleRate))
            const highBin = Math.min(half - 1, Math.ceil(frequency * HALF_OCTAVE * FFT_SIZE / sampleRate))
            let sum = 0.0
            for (let bin = lowBin; bin <= highBin; bin++) {sum += power[bin]}
            return 10.0 * Math.log10(sum + 1.0e-12)
        }
        const nyquist = sampleRate * 0.5
        const minFrequency = MIN_FREQUENCY
        const maxFrequency = Math.min(MAX_FREQUENCY, nyquist * 0.9)
        const probeFrequencies = new Float64Array(PROBES)
        const probeMeasured = new Float64Array(PROBES)
        for (let p = 0; p < PROBES; p++) {
            const frequency = minFrequency * Math.pow(maxFrequency / minFrequency, p / (PROBES - 1))
            probeFrequencies[p] = frequency
            probeMeasured[p] = measuredAt(frequency)
        }
        // Reference target: a straight tonal slope, pink (flat) at tilt 0, brighter/darker as tilt moves. The
        // correction is the gain-neutral difference between target and measured (its mean removed), so the
        // overall level is left alone and only the tonal shape is matched. A mix already on the target needs
        // nothing, and because the target is fixed a re-analysis of the corrected mix converges to no change.
        const diffs = new Float64Array(PROBES)
        let weightSum = 0.0
        let weightedDiff = 0.0
        for (let p = 0; p < PROBES; p++) {
            diffs[p] = tilt * Math.log2(probeFrequencies[p] / 1000.0) - probeMeasured[p]
            const energy = Math.pow(10.0, probeMeasured[p] / 10.0) // linear energy in this band
            weightSum += energy
            weightedDiff += energy * diffs[p]
        }
        // Subtract the ENERGY-weighted mean, not a flat one: this keeps the correction loudness-neutral (it
        // changes tonal shape but adds no net energy), so boosts on loud bands do not raise the overall level.
        const diffMean = weightSum > 0.0 ? weightedDiff / weightSum : 0.0
        const probeDeviations = new Float64Array(PROBES)
        for (let p = 0; p < PROBES; p++) {probeDeviations[p] = diffs[p] - diffMean}
        const normFrequencies = new Float32Array(PROBES)
        for (let p = 0; p < PROBES; p++) {normFrequencies[p] = probeFrequencies[p] / sampleRate}
        const responseAt = (build: (coeff: BiquadCoeff, gainDb: number) => void, gainDb: number): Float64Array => {
            const coeff = new BiquadCoeff()
            build(coeff, gainDb)
            const magnitude = new Float32Array(PROBES)
            const phase = new Float32Array(PROBES)
            coeff.getFrequencyResponse(normFrequencies, magnitude, phase)
            const response = new Float64Array(PROBES)
            for (let p = 0; p < PROBES; p++) {response[p] = 20.0 * Math.log10(Math.max(magnitude[p], 1.0e-9))}
            return response
        }
        // Gauss-Newton least squares: re-linearize each section's per-dB shape at its fitted gain (a shelf/bell
        // response is not linear in gain) and re-solve, so the combined REALIZED curve matches the target.
        const fit = (builders: ReadonlyArray<(coeff: BiquadCoeff, gainDb: number) => void>,
                     target: Float64Array): Float64Array => {
            const count = builders.length
            let gains = new Float64Array(count)
            for (let iteration = 0; iteration < FIT_ITERATIONS; iteration++) {
                const shapes = builders.map((build, band) => {
                    const reference = Math.abs(gains[band]) < 1.0 ? (gains[band] < 0.0 ? -1.0 : 1.0) : gains[band]
                    const response = responseAt(build, reference)
                    return response.map(value => value / reference)
                })
                const matrix = shapes.map((rowShape, row) => {
                    const equation = new Float64Array(count)
                    for (let col = 0; col < count; col++) {
                        let dot = 0.0
                        for (let p = 0; p < PROBES; p++) {dot += rowShape[p] * shapes[col][p]}
                        equation[col] = dot + (row === col ? RIDGE : 0.0)
                    }
                    return equation
                })
                const rhs = shapes.map(rowShape => {
                    let dot = 0.0
                    for (let p = 0; p < PROBES; p++) {dot += rowShape[p] * target[p]}
                    return dot
                })
                gains = solve(matrix, rhs).map(gain => clamp(gain, -maxGain, maxGain))
            }
            return gains
        }
        const lowShelfBuild = (coeff: BiquadCoeff, gainDb: number) =>
            coeff.setLowShelfParams(LOW_SHELF_FREQUENCY / sampleRate, gainDb)
        const highShelfBuild = (coeff: BiquadCoeff, gainDb: number) =>
            coeff.setHighShelfParams(HIGH_SHELF_FREQUENCY / sampleRate, gainDb)
        // 1) fit the two shelves to the broadband tilt, 2) place the three bells on the largest features the
        // shelves leave behind, 3) fit all five together. Movable bells actually cancel real peaks/dips.
        const shelfGains = fit([lowShelfBuild, highShelfBuild], probeDeviations)
        const lowShelfResponse = responseAt(lowShelfBuild, shelfGains[0])
        const highShelfResponse = responseAt(highShelfBuild, shelfGains[1])
        const residual = new Float64Array(PROBES)
        for (let p = 0; p < PROBES; p++) {residual[p] = probeDeviations[p] - lowShelfResponse[p] - highShelfResponse[p]}
        const bellFrequencies = chooseBells(probeFrequencies, residual)
        const builders = [
            lowShelfBuild,
            (coeff: BiquadCoeff, gainDb: number) => coeff.setPeakingParams(bellFrequencies[0] / sampleRate, BELL_Q, gainDb),
            (coeff: BiquadCoeff, gainDb: number) => coeff.setPeakingParams(bellFrequencies[1] / sampleRate, BELL_Q, gainDb),
            (coeff: BiquadCoeff, gainDb: number) => coeff.setPeakingParams(bellFrequencies[2] / sampleRate, BELL_Q, gainDb),
            highShelfBuild
        ]
        // Fit, then drive the realized loudness change to zero: the fit is only shape-neutral, but the dB->
        // linear convexity and the clamp still add a little level. Measure the energy-weighted level the EQ
        // adds over the mix's own spectrum and fold it back into the target, so the final EQ is level-neutral.
        const energies = Float64Array.from(probeMeasured, measured => Math.pow(10.0, measured / 10.0))
        const realizedMakeup = (gains: Float64Array): number => {
            let energyAfter = 0.0
            for (let p = 0; p < PROBES; p++) {
                let combined = 0.0
                builders.forEach((build, band) => {combined += responseAt(build, gains[band])[p]})
                energyAfter += energies[p] * Math.pow(10.0, combined / 10.0)
            }
            return 10.0 * Math.log10(energyAfter / weightSum + 1.0e-12)
        }
        let makeup = 0.0
        let gains = fit(builders, probeDeviations)
        for (let pass = 0; pass < MAKEUP_ITERATIONS; pass++) {
            const realized = realizedMakeup(gains)
            if (Math.abs(realized) < 0.05) {break}
            makeup += realized
            gains = fit(builders, probeDeviations.map(deviation => deviation - makeup))
        }
        return {
            lowShelf: {frequency: LOW_SHELF_FREQUENCY, gainDb: gains[0]},
            lowBell: {frequency: bellFrequencies[0], gainDb: gains[1]},
            midBell: {frequency: bellFrequencies[1], gainDb: gains[2]},
            highBell: {frequency: bellFrequencies[2], gainDb: gains[3]},
            highShelf: {frequency: HIGH_SHELF_FREQUENCY, gainDb: gains[4]}
        }
    }

    const flat = (): Result => ({
        lowShelf: {frequency: LOW_SHELF_FREQUENCY, gainDb: 0.0},
        lowBell: {frequency: BELL_DEFAULT_FREQUENCIES[0], gainDb: 0.0},
        midBell: {frequency: BELL_DEFAULT_FREQUENCIES[1], gainDb: 0.0},
        highBell: {frequency: BELL_DEFAULT_FREQUENCIES[2], gainDb: 0.0},
        highShelf: {frequency: HIGH_SHELF_FREQUENCY, gainDb: 0.0}
    })

    // Pick three bell centres on the largest interior features of the residual, spaced apart so they target
    // distinct peaks/dips rather than clustering on one; pad from the defaults if the mix is featureless.
    const chooseBells = (frequencies: Float64Array, residual: Float64Array): ReadonlyArray<number> => {
        const candidates: Array<{ frequency: number, weight: number }> = []
        for (let p = 0; p < frequencies.length; p++) {
            if (frequencies[p] >= BELL_MIN_FREQUENCY && frequencies[p] <= BELL_MAX_FREQUENCY) {
                candidates.push({frequency: frequencies[p], weight: Math.abs(residual[p])})
            }
        }
        candidates.sort((left, right) => right.weight - left.weight)
        const chosen: Array<number> = []
        const spaced = (frequency: number) =>
            chosen.every(other => Math.abs(Math.log2(frequency / other)) >= BELL_MIN_SPACING)
        for (const candidate of candidates) {
            if (chosen.length === 3) {break}
            if (spaced(candidate.frequency)) {chosen.push(candidate.frequency)}
        }
        for (const fallback of BELL_DEFAULT_FREQUENCIES) {
            if (chosen.length === 3) {break}
            if (spaced(fallback)) {chosen.push(fallback)}
        }
        while (chosen.length < 3) {chosen.push(BELL_DEFAULT_FREQUENCIES[chosen.length])}
        return chosen.sort((left, right) => left - right)
    }

    // Gaussian elimination with partial pivoting for the small symmetric normal-equations system.
    const solve = (matrix: ReadonlyArray<Float64Array>, rhs: ReadonlyArray<number>): Float64Array => {
        const size = rhs.length
        const augmented = matrix.map((row, index) => {
            const copy = new Float64Array(size + 1)
            copy.set(row)
            copy[size] = rhs[index]
            return copy
        })
        for (let column = 0; column < size; column++) {
            let pivot = column
            for (let row = column + 1; row < size; row++) {
                if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {pivot = row}
            }
            const swap = augmented[column]
            augmented[column] = augmented[pivot]
            augmented[pivot] = swap
            const diagonal = augmented[column][column]
            if (Math.abs(diagonal) < 1.0e-12) {continue}
            for (let row = 0; row < size; row++) {
                if (row === column) {continue}
                const factor = augmented[row][column] / diagonal
                for (let col = column; col <= size; col++) {augmented[row][col] -= factor * augmented[column][col]}
            }
        }
        const solution = new Float64Array(size)
        for (let row = 0; row < size; row++) {
            const diagonal = augmented[row][row]
            solution[row] = Math.abs(diagonal) < 1.0e-12 ? 0.0 : augmented[row][size] / diagonal
        }
        return solution
    }
}
