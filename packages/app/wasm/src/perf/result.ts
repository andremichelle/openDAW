// The result of one offline render (a stereo master + the render-loop time). Kept in its own tiny module so the
// main-thread page can build audio players from a worker's result WITHOUT importing the heavy engine renderers.
import {AudioData, WavFile} from "@opendaw/lib-dsp"

export type OfflineResult = {left: Float32Array, right: Float32Array, renderMs: number, sampleRate: number}

// The peak sample magnitude across both channels (0 = silence).
export const resultPeak = (result: OfflineResult): number => {
    let peak = 0
    for (let i = 0; i < result.left.length; i++) {peak = Math.max(peak, Math.abs(result.left[i]), Math.abs(result.right[i]))}
    return peak
}

// The RMS level across both channels (the perceived-loudness metric).
export const resultRms = (result: OfflineResult): number => {
    let sum = 0
    const frames = result.left.length
    for (let i = 0; i < frames; i++) {sum += result.left[i] * result.left[i] + result.right[i] * result.right[i]}
    return frames > 0 ? Math.sqrt(sum / (frames * 2)) : 0
}

// Encode a rendered result as a 16-bit WAV Blob URL for an <audio> element (main thread only — needs URL).
export const resultToWavUrl = (result: OfflineResult): string => {
    const data = AudioData.create(result.sampleRate, result.left.length, 2)
    data.frames[0].set(result.left)
    data.frames[1].set(result.right)
    const wav = WavFile.encodeInts16(data)
    return URL.createObjectURL(new Blob([wav], {type: "audio/wav"}))
}
