import {asDefined, clampUnit, panic} from "@opendaw/lib-std"
import {BiquadCoeff, BiquadStack, FFT, ResamplerMono, SampleRateConverter} from "@opendaw/lib-dsp"
import {defineTask, TaskEnvironment} from "../Task"
import {tensor, TensorMap} from "../Tensor"

export interface TempoDetectionInput {
    /** Mono PCM. Any sample rate at or above 11025 Hz; it is resampled to 11025 before analysis. */
    readonly audio: Float32Array
    readonly sampleRate: number
}

export interface TempoCandidate {
    readonly bpm: number
    readonly probability: number
}

export interface TempoDetectionOutput {
    readonly bpm: number
    /** Mass on the winning bin after averaging softmax across windows. */
    readonly confidence: number
    /** Top-N candidates by averaged softmax mass, sorted descending. Useful
     *  for diagnosing octave errors: if `bpm/2` or `bpm*2` shows up here
     *  with non-trivial probability, the model is doing its job and the
     *  pick is just the dominant octave. */
    readonly topCandidates: ReadonlyArray<TempoCandidate>
}

const TARGET_SR = 11025
const N_FFT = 1024
const HOP = 512
const N_MELS = 40
const FMIN_HZ = 20
const FMAX_HZ = 5000
const FRAMES_PER_WINDOW = 256
// Stride between successive 256-frame inference windows (frames). Matches
// `hop_length=128` in `tempocnn/feature.py:read_features`, i.e. 50 % overlap.
// More windows = smoother softmax averaging.
const WINDOW_STRIDE_FRAMES = 128
const BPM_OFFSET = 30
const BPM_BINS = 256

// Octave-folding window. TempoCNN tends to pick the half-tempo bin on
// drum-only material with sparse on-beat patterns (e.g. 154 BPM drums →
// 77). If the winning bin lands outside this window AND the alternate
// octave inside the window has at least OCTAVE_MASS_FRAC of the winner's
// mass, prefer the alternate. The 0.3 threshold is empirical and avoids
// over-correcting genuine slow/fast tempos where the alt octave has
// negligible mass.
const OCTAVE_PREF_MIN = 90
const OCTAVE_PREF_MAX = 180
const OCTAVE_MASS_FRAC = 0.3

// Softmax smearing: the model spreads probability across adjacent BPM bins
// because tempo is a continuous quantity. Summing ±CLUSTER_HALF_WIDTH bins
// gives a meaningful "this tempo cluster" mass rather than per-bin mass.
const CLUSTER_HALF_WIDTH = 2

const RESAMPLE_CHUNK_OUT = 128

export const TempoDetectionTask = defineTask<TempoDetectionInput, TempoDetectionOutput>({
    key: "tempo-detection",
    model: {
        // TempoCNN cnn.h5 (Schreiber & Müller, default global-tempo classifier,
        // AGPL-3.0). Upstream is Keras .h5; this ONNX is produced by tf2onnx
        // (see scripts/download-inference-models.sh `convert_tempo_cnn`).
        // Input  [N, 40, 256, 1]  — 40 mel bands × 256 frames × 1 channel
        // Output [N, 256]          — softmax over BPM bins 30..285 (1 BPM step)
        url: "https://assets.opendaw.studio/models/tempo-cnn/v0/model.onnx",
        sha256: "38b4915b35c46f72e072a7c93ab4b7e280404133e2ca94f9cbcf5ace15c7a321",
        bytes: 11_705_795,
        version: "v0-cnn"
    },
    executionProviders: ["wasm"],
    async run(input: TempoDetectionInput, env: TaskEnvironment): Promise<TempoDetectionOutput> {
        env.signal.match({none: () => {}, some: signal => signal.throwIfAborted()})
        const audio = downsampleTo11025(input.audio, input.sampleRate)
        const numFrames = Math.max(0, Math.floor((audio.length - N_FFT) / HOP) + 1)
        if (numFrames === 0) {
            return panic(`Audio too short for tempo detection (need ≥${N_FFT / TARGET_SR}s at 11025 Hz, got ${audio.length} samples)`)
        }
        const mel = computeMelSpectrogram(audio, numFrames)
        const inputName = asDefined(env.inputNames[0], "tempo-cnn: missing input name")
        const outputName = asDefined(env.outputNames[0], "tempo-cnn: missing output name")
        const accumulated = new Float64Array(BPM_BINS)
        const numWindows = numFrames < FRAMES_PER_WINDOW
            ? 1
            : Math.floor((numFrames - FRAMES_PER_WINDOW) / WINDOW_STRIDE_FRAMES) + 1
        for (let windowIndex = 0; windowIndex < numWindows; windowIndex++) {
            env.signal.match({none: () => {}, some: signal => signal.throwIfAborted()})
            const startFrame = windowIndex * WINDOW_STRIDE_FRAMES
            const tile = packWindow(mel, startFrame, numFrames)
            const feeds: TensorMap = {
                [inputName]: tensor("float32", tile, [1, N_MELS, FRAMES_PER_WINDOW, 1])
            }
            const output = await env.session(feeds)
            const probs = asDefined(output[outputName], `tempo-cnn: missing output '${outputName}'`).data as Float32Array
            for (let bin = 0; bin < BPM_BINS; bin++) accumulated[bin] += probs[bin]
            env.progress(clampUnit((windowIndex + 1) / numWindows))
        }
        const averaged = new Float32Array(BPM_BINS)
        for (let bin = 0; bin < BPM_BINS; bin++) averaged[bin] = accumulated[bin] / numWindows
        // Top-3 by raw bin mass — picking the bin with highest window-sum
        // would shift the BPM by ±1 in clusters where adjacent bins share
        // smearing (e.g. 153 having more mass than 154 in the same cluster
        // around 154). The winner is locked to the actual peak.
        const topCandidates = topN(averaged, 3)
        const winner = clampOctave(topCandidates[0], averaged)
        // Confidence is the cluster mass (±CLUSTER_HALF_WIDTH bins) at the
        // winner's bin, NOT the single-bin mass. Single-bin reads severely
        // underestimate confidence because the model spreads probability
        // across adjacent BPM bins.
        const winnerBin = winner.bpm - BPM_OFFSET
        const confidence = windowSum(averaged, winnerBin)
        return {
            bpm: winner.bpm,
            confidence: clampUnit(confidence),
            topCandidates
        }
    }
})

const topN = (probs: Float32Array, n: number): ReadonlyArray<TempoCandidate> => {
    const indices = Array.from({length: probs.length}, (_, index) => index)
    indices.sort((leftIndex, rightIndex) => probs[rightIndex] - probs[leftIndex])
    return indices.slice(0, n).map((index): TempoCandidate => ({
        bpm: BPM_OFFSET + index,
        probability: probs[index]
    }))
}

const windowSum = (probs: Float32Array, centerBin: number): number => {
    let sum = 0
    for (let offset = -CLUSTER_HALF_WIDTH; offset <= CLUSTER_HALF_WIDTH; offset++) {
        const index = centerBin + offset
        if (index >= 0 && index < probs.length) {sum += probs[index]}
    }
    return sum
}

const clampOctave = (winner: TempoCandidate, probs: Float32Array): TempoCandidate => {
    if (winner.bpm >= OCTAVE_PREF_MIN && winner.bpm <= OCTAVE_PREF_MAX) {return winner}
    const alternate = winner.bpm < OCTAVE_PREF_MIN ? winner.bpm * 2 : winner.bpm / 2
    if (alternate < OCTAVE_PREF_MIN || alternate > OCTAVE_PREF_MAX) {return winner}
    if (!Number.isInteger(alternate)) {return winner}
    const alternateBin = alternate - BPM_OFFSET
    if (alternateBin < 0 || alternateBin >= probs.length) {return winner}
    const alternateMass = windowSum(probs, alternateBin)
    if (alternateMass < winner.probability * OCTAVE_MASS_FRAC) {return winner}
    return {bpm: alternate, probability: alternateMass}
}

// Decimation to 11025 Hz for ANY input rate, in two steps. The model's mel filterbank was trained
// against 40 bands across 0..5512.5 Hz, so everything above the target Nyquist has to be gone before
// the rate changes.
//   1. Halve with the polyphase resampler (its half-band filters do the anti-aliasing) as often as
//      the rate stays at or above the target: 48000 -> 12000, 88200 -> 11025, 32000 -> 16000.
//   2. Whatever ratio is left is fractional. `SampleRateConverter` interpolates linearly and filters
//      nothing, so the remaining band above the target Nyquist is low-passed away first. Without
//      that filter a 32 kHz input folds 5512..8000 Hz straight back into the mel range.
// An input already at 11025, or one an exact power of two above it, takes step 1 alone and comes out
// bit-identical to what this function produced before.
const LOWPASS_ORDER = 4
const LOWPASS_MARGIN = 0.9 // of the target Nyquist, leaving the filter room to roll off

export const downsampleTo11025 = (audio: Float32Array, sampleRate: number): Float32Array => {
    if (sampleRate <= 0) {return panic(`tempo-cnn: invalid sampleRate ${sampleRate}`)}
    if (sampleRate < TARGET_SR) {
        return panic(`tempo-cnn requires at least ${TARGET_SR} Hz — got ${sampleRate}`)
    }
    const halvings = Math.min(3, Math.floor(Math.log2(sampleRate / TARGET_SR)))
    const factor = (1 << halvings) as 1 | 2 | 4 | 8
    const decimated = factor === 1 ? audio : halve(audio, factor)
    const decimatedRate = sampleRate / factor
    if (decimatedRate === TARGET_SR) {return decimated}
    return SampleRateConverter.convert(lowpass(decimated, decimatedRate), decimatedRate, TARGET_SR)
}

const halve = (audio: Float32Array, factor: 2 | 4 | 8): Float32Array => {
    const resampler = new ResamplerMono(factor)
    const outputLength = Math.floor(audio.length / factor)
    const out = new Float32Array(outputLength)
    let written = 0
    while (written < outputLength) {
        const chunkOut = Math.min(RESAMPLE_CHUNK_OUT, outputLength - written)
        resampler.downsample(audio.subarray(written * factor, (written + chunkOut) * factor),
            out, written, written + chunkOut)
        written += chunkOut
    }
    return out
}

// Forward then backward through the same cascade: the reverse pass undoes the phase shift of the
// forward one, so the beat positions the model reads stay where they are.
const lowpass = (audio: Float32Array, sampleRate: number): Float32Array => {
    const coeff = new BiquadCoeff().setLowpassParams(TARGET_SR * 0.5 * LOWPASS_MARGIN / sampleRate)
    const stack = new BiquadStack(LOWPASS_ORDER)
    const forward = new Float32Array(audio.length)
    stack.process(coeff, audio, forward, 0, audio.length)
    forward.reverse()
    const backward = new Float32Array(audio.length)
    stack.reset()
    stack.process(coeff, forward, backward, 0, backward.length)
    backward.reverse()
    return backward
}

// Mirrors `librosa.feature.melspectrogram(power=1, n_fft=1024, hop_length=512,
// n_mels=40, fmin=20, fmax=5000)` from `tempocnn/feature.py:read_features`.
// CRITICAL: TempoCNN feeds the linear *magnitude* mel-spectrogram to the
// model — no `power_to_db`, no log, no normalization. Adding any of those
// catastrophically corrupts the input distribution and the model produces
// garbage (verified empirically: drums-stem reported 49 BPM on a 155-BPM
// track when log-dB normalization was applied).
const computeMelSpectrogram = (audio: Float32Array, numFrames: number): Float32Array => {
    const fft = new FFT(N_FFT)
    const window = hannWindow(N_FFT)
    const real = new Float32Array(N_FFT)
    const imag = new Float32Array(N_FFT)
    const numBins = N_FFT / 2 + 1
    const melWeights = melFilterbank(TARGET_SR, N_FFT, N_MELS, FMIN_HZ, FMAX_HZ)
    const mel = new Float32Array(numFrames * N_MELS)
    for (let frame = 0; frame < numFrames; frame++) {
        const start = frame * HOP
        for (let i = 0; i < N_FFT; i++) {
            real[i] = audio[start + i] * window[i]
            imag[i] = 0
        }
        fft.process(real, imag)
        for (let melIndex = 0; melIndex < N_MELS; melIndex++) {
            let sum = 0
            const weightOffset = melIndex * numBins
            for (let bin = 0; bin < numBins; bin++) {
                const magnitude = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin])
                sum += magnitude * melWeights[weightOffset + bin]
            }
            mel[frame * N_MELS + melIndex] = sum
        }
    }
    return mel
}

// Build a [40, 256, 1] Float32Array for one inference window in NHWC layout
// (TF/Keras convention preserved by tf2onnx). For audio shorter than
// FRAMES_PER_WINDOW we zero-pad the right edge — silence in mel-magnitude
// space is exactly zero, which is what `_ensure_length` does upstream.
const packWindow = (mel: Float32Array, startFrame: number, numFrames: number): Float32Array => {
    const tile = new Float32Array(N_MELS * FRAMES_PER_WINDOW)
    const usableFrames = Math.min(FRAMES_PER_WINDOW, numFrames - startFrame)
    for (let melIndex = 0; melIndex < N_MELS; melIndex++) {
        const tileRowOffset = melIndex * FRAMES_PER_WINDOW
        for (let f = 0; f < usableFrames; f++) {
            tile[tileRowOffset + f] = mel[(startFrame + f) * N_MELS + melIndex]
        }
    }
    return tile
}

const hannWindow = (n: number): Float32Array => {
    // Periodic Hann (`scipy.signal.get_window('hann', N, fftbins=True)`),
    // which is what librosa.stft uses by default. The symmetric variant
    // (divisor n-1) would shift the window energy slightly and mismatch
    // the model's training-time spectrogram.
    const window = new Float32Array(n)
    for (let i = 0; i < n; i++) {
        window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n))
    }
    return window
}

// Slaney mel scale (librosa default). Returns a [N_MELS × numBins]
// row-major matrix of triangular filter weights, area-normalized to
// 2 / (right_hz - left_hz) — librosa's "slaney" filterbank norm.
const melFilterbank = (sampleRate: number, nFft: number, nMels: number,
                       fmin: number, fmax: number): Float32Array => {
    const numBins = nFft / 2 + 1
    const fSp = 200 / 3
    const minLogHz = 1000
    const minLogMel = minLogHz / fSp
    const stepLog = Math.log(6.4) / 27
    const hzToMel = (hz: number) =>
        hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / stepLog
    const melToHz = (mel: number) =>
        mel < minLogMel ? mel * fSp : minLogHz * Math.exp(stepLog * (mel - minLogMel))
    const melMin = hzToMel(fmin)
    const melMax = hzToMel(fmax)
    const hzPoints = new Float64Array(nMels + 2)
    const binPoints = new Float64Array(nMels + 2)
    for (let i = 0; i < nMels + 2; i++) {
        const m = melMin + (melMax - melMin) * i / (nMels + 1)
        hzPoints[i] = melToHz(m)
        binPoints[i] = hzPoints[i] * nFft / sampleRate
    }
    const weights = new Float32Array(nMels * numBins)
    for (let melIndex = 0; melIndex < nMels; melIndex++) {
        const left = binPoints[melIndex]
        const peak = binPoints[melIndex + 1]
        const right = binPoints[melIndex + 2]
        const enorm = 2 / (hzPoints[melIndex + 2] - hzPoints[melIndex])
        const offset = melIndex * numBins
        for (let bin = 0; bin < numBins; bin++) {
            let weight = 0
            if (bin > left && bin < peak) {
                weight = (bin - left) / (peak - left)
            } else if (bin >= peak && bin < right) {
                weight = (right - bin) / (right - peak)
            }
            weights[offset + bin] = weight * enorm
        }
    }
    return weights
}
