import {HT_EPS, SEGMENT_LENGTH, STFT_FREQ_BINS, STFT_TIME_FRAMES} from "./Constants"
import {buildSpectrogramInput, StftContext} from "./Stft"

export type NormStats = {
    readonly mean: number
    readonly std: number
    readonly meant: number
    readonly stdt: number
}

export type PreForwardResult = NormStats & {
    readonly xBuf: Float32Array
    readonly xtBuf: Float32Array
}

const normalizeInPlace = (buffer: Float32Array): {mean: number, std: number} => {
    const n = buffer.length
    let sum = 0
    for (let i = 0; i < n; i++) {sum += buffer[i]}
    const mean = sum / n
    let sqSum = 0
    for (let i = 0; i < n; i++) {
        const diff = buffer[i] - mean
        sqSum += diff * diff
    }
    const std = Math.sqrt(sqSum / (n - 1))
    const invDenom = 1 / (HT_EPS + std)
    for (let i = 0; i < n; i++) {buffer[i] = (buffer[i] - mean) * invDenom}
    return {mean, std}
}

/**
 * Consumes a raw segment (planar stereo [left | right], length 2 × SEGMENT_LENGTH) and produces
 * the normalized x and xt tensors to feed into the ONNX `fwd` graph, plus the norm stats needed
 * by post-forward to de-normalize the outputs.
 */
export const htdemucsPreForward = (stft: StftContext, segmentData: Float32Array): PreForwardResult => {
    const xBuf = new Float32Array(1 * 4 * STFT_FREQ_BINS * STFT_TIME_FRAMES)
    buildSpectrogramInput(stft, segmentData, xBuf, SEGMENT_LENGTH)
    const {mean, std} = normalizeInPlace(xBuf)
    const xtBuf = new Float32Array(segmentData.length)
    xtBuf.set(segmentData)
    const {mean: meant, std: stdt} = normalizeInPlace(xtBuf)
    return {xBuf, xtBuf, mean, std, meant, stdt}
}
