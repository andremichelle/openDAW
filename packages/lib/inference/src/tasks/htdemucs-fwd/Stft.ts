import {
    STFT_CENTER_PAD,
    STFT_DEMUCS_PAD_LEFT,
    STFT_FREQ_BINS,
    STFT_HOP,
    STFT_N_FFT,
    STFT_NORM,
    STFT_TIME_FRAMES
} from "./Constants"
import {
    buildBitReverseTable,
    buildFftTwiddles,
    buildHannWindow,
    FftTwiddles,
    fftInPlace,
    ifftInPlace,
    padReflect1d
} from "./Fft"

export class StftContext {
    readonly hannWindow: Float32Array
    readonly twiddles: FftTwiddles
    readonly bitRev: Uint32Array
    readonly scratchReal: Float32Array
    readonly scratchImag: Float32Array

    constructor() {
        this.hannWindow = buildHannWindow(STFT_N_FFT)
        this.twiddles = buildFftTwiddles(STFT_N_FFT)
        this.bitRev = buildBitReverseTable(STFT_N_FFT)
        this.scratchReal = new Float32Array(STFT_N_FFT)
        this.scratchImag = new Float32Array(STFT_N_FFT)
    }

    /**
     * Computes STFT of a single channel and writes real/imag into dst at the given offsets.
     * Writes STFT_FREQ_BINS × STFT_TIME_FRAMES planar values per half.
     */
    computeStftChannel(
        signal: Float32Array,
        dst: Float32Array,
        realChannelOffset: number,
        imagChannelOffset: number
    ): void {
        const N = signal.length
        const le = Math.max(Math.ceil(N / STFT_HOP), STFT_TIME_FRAMES - 2)
        const padRight1 = STFT_DEMUCS_PAD_LEFT + le * STFT_HOP - N
        const pre1 = padReflect1d(signal, STFT_DEMUCS_PAD_LEFT, padRight1)
        const pre2 = padReflect1d(pre1, STFT_CENTER_PAD, STFT_CENTER_PAD)
        const numFrames = Math.floor(pre1.length / STFT_HOP) + 1
        for (let frameIdx = 0; frameIdx < STFT_TIME_FRAMES; frameIdx++) {
            const sourceFrame = frameIdx + 2
            if (sourceFrame >= numFrames) {
                for (let f = 0; f < STFT_FREQ_BINS; f++) {
                    dst[realChannelOffset + f * STFT_TIME_FRAMES + frameIdx] = 0
                    dst[imagChannelOffset + f * STFT_TIME_FRAMES + frameIdx] = 0
                }
                continue
            }
            const sampleStart = sourceFrame * STFT_HOP
            const real = this.scratchReal
            const imag = this.scratchImag
            for (let i = 0; i < STFT_N_FFT; i++) {
                real[i] = pre2[sampleStart + i] * this.hannWindow[i]
                imag[i] = 0
            }
            fftInPlace(real, imag, STFT_N_FFT, this.twiddles, this.bitRev)
            for (let f = 0; f < STFT_FREQ_BINS; f++) {
                dst[realChannelOffset + f * STFT_TIME_FRAMES + frameIdx] = real[f] * STFT_NORM
                dst[imagChannelOffset + f * STFT_TIME_FRAMES + frameIdx] = imag[f] * STFT_NORM
            }
        }
    }

    /**
     * Inverse STFT of a single channel. Input: real/imag arrays of length (STFT_FREQ_BINS + 1) × numFrames
     * (hermitian half-spectrum with an extra zero-padded freq row). Returns the raw iSTFT waveform
     * with the center-pad stripped: length = (numFrames - 1) × hop.
     */
    computeIstftChannel(realFrames: Float32Array, imagFrames: Float32Array, numFrames: number): Float32Array {
        const nFft = STFT_N_FFT
        const hop = STFT_HOP
        const nHalfPlusOne = nFft / 2 + 1
        const nyquistIdx = nFft / 2
        const centerPad = nFft / 2
        const rawLen = (numFrames - 1) * hop + nFft
        const acc = new Float32Array(rawLen)
        const winSum = new Float32Array(rawLen)
        const scale = Math.sqrt(nFft)
        const real = this.scratchReal
        const imag = this.scratchImag
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            for (let k = 0; k < nHalfPlusOne; k++) {
                real[k] = realFrames[k * numFrames + frameIdx]
                imag[k] = imagFrames[k * numFrames + frameIdx]
            }
            for (let k = 1; k < nyquistIdx; k++) {
                real[nFft - k] = real[k]
                imag[nFft - k] = -imag[k]
            }
            ifftInPlace(real, imag, nFft, this.twiddles, this.bitRev)
            const base = frameIdx * hop
            for (let i = 0; i < nFft; i++) {
                const w = this.hannWindow[i]
                acc[base + i] += real[i] * w * scale
                winSum[base + i] += w * w
            }
        }
        for (let i = 0; i < rawLen; i++) {
            if (winSum[i] > 1e-8) {acc[i] /= winSum[i]}
        }
        const trimmed = new Float32Array(rawLen - 2 * centerPad)
        trimmed.set(acc.subarray(centerPad, rawLen - centerPad))
        return trimmed
    }
}

/**
 * Builds the CAC (complex-as-channels) magnitude input tensor x ∈ [1, 4, 2048, 336] with layout
 * [real_L, imag_L, real_R, imag_R], from a segment's planar stereo Float32Array [left | right]
 * of length 2 × SEGMENT_LENGTH.
 */
export const buildSpectrogramInput = (
    stft: StftContext,
    segmentData: Float32Array,
    dst: Float32Array,
    segmentLength: number
): void => {
    const blockSize = STFT_FREQ_BINS * STFT_TIME_FRAMES
    const realL = 0
    const imagL = blockSize
    const realR = 2 * blockSize
    const imagR = 3 * blockSize
    const leftView = segmentData.subarray(0, segmentLength)
    const rightView = segmentData.subarray(segmentLength, 2 * segmentLength)
    stft.computeStftChannel(leftView, dst, realL, imagL)
    stft.computeStftChannel(rightView, dst, realR, imagR)
}
