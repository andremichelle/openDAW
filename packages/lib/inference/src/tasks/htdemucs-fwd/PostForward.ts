import {NUM_STEMS, SEGMENT_LENGTH, STFT_FREQ_BINS, STFT_HOP, STFT_TIME_FRAMES} from "./Constants"
import {NormStats} from "./PreForward"
import {StftContext} from "./Stft"

const CAC = 4
const STEREO = 2

/**
 * Consumes the two ONNX `fwd` outputs plus the norm stats captured by pre_forward, returns
 * the per-stem waveforms as a single Float32Array laid out as [1, 4, 2, SEGMENT_LENGTH].
 * Source index for stem s, stereo channel c, sample i: s * (2 * SEGMENT_LENGTH) + c * SEGMENT_LENGTH + i.
 */
export const htdemucsPostForward = (
    stft: StftContext,
    xOut: Float32Array,
    xtOut: Float32Array,
    {mean, std, meant, stdt}: NormStats
): Float32Array => {
    const FR = STFT_FREQ_BINS
    const T = STFT_TIME_FRAMES
    const FR_PLUS_1 = FR + 1
    const T_PLUS_4 = T + 4
    const nBinsFull = FR_PLUS_1 * T_PLUS_4
    const sources = new Float32Array(1 * NUM_STEMS * STEREO * SEGMENT_LENGTH)
    const realBuf = new Float32Array(nBinsFull)
    const imagBuf = new Float32Array(nBinsFull)
    for (let stem = 0; stem < NUM_STEMS; stem++) {
        for (let chan = 0; chan < STEREO; chan++) {
            const cacRealIdx = stem * (CAC * FR * T) + (chan * 2 + 0) * (FR * T)
            const cacImagIdx = stem * (CAC * FR * T) + (chan * 2 + 1) * (FR * T)
            realBuf.fill(0)
            imagBuf.fill(0)
            for (let f = 0; f < FR; f++) {
                for (let t = 0; t < T; t++) {
                    const srcR = cacRealIdx + f * T + t
                    const srcI = cacImagIdx + f * T + t
                    const dst = f * T_PLUS_4 + (t + 2)
                    realBuf[dst] = xOut[srcR] * std + mean
                    imagBuf[dst] = xOut[srcI] * std + mean
                }
            }
            const wave = stft.computeIstftChannel(realBuf, imagBuf, T_PLUS_4)
            const trimStart = (STFT_HOP / 2) * 3
            const dstBase = stem * (STEREO * SEGMENT_LENGTH) + chan * SEGMENT_LENGTH
            for (let i = 0; i < SEGMENT_LENGTH; i++) {
                sources[dstBase + i] = wave[trimStart + i]
            }
        }
    }
    for (let stem = 0; stem < NUM_STEMS; stem++) {
        for (let chan = 0; chan < STEREO; chan++) {
            const base = stem * (STEREO * SEGMENT_LENGTH) + chan * SEGMENT_LENGTH
            for (let i = 0; i < SEGMENT_LENGTH; i++) {
                sources[base + i] += xtOut[base + i] * stdt + meant
            }
        }
    }
    return sources
}
