import {FFT} from "@opendaw/lib-dsp"
import {MuScriptorInput} from "./types"

const SAMPLE_RATE = 16000, FFT_SIZE = 2048, HOP = 160, MELS = 512
export const CHUNK_SAMPLES = 80000

/** Offline low-pass resampling, in the inference worker, before STFT. */
export const prepareMuScriptorAudio = ({channels, sampleRate, start, end}: MuScriptorInput): Float32Array => {
    if (!Number.isFinite(sampleRate) || sampleRate < 1000 || channels.length === 0
        || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error("Invalid audio range for MuScriptor")
    }
    const length = channels[0].length
    if (channels.some(channel => channel.length !== length) || end > length / sampleRate + 1 / sampleRate) {
        throw new Error("Audio channels or selected range do not match")
    }
    const first = Math.floor(start * sampleRate), last = Math.min(length, Math.ceil(end * sampleRate))
    const mono = new Float32Array(last - first)
    for (let i = 0; i < mono.length; i++) {
        let value = 0
        for (const channel of channels) {
            if (!Number.isFinite(channel[first + i])) {throw new Error("Audio contains non-finite samples")}
            value += channel[first + i]
        }
        mono[i] = value / channels.length
    }
    if (sampleRate === SAMPLE_RATE) {return mono}
    const ratio = sampleRate / SAMPLE_RATE, cutoff = Math.min(1, 1 / ratio) * 0.94
    const radius = Math.ceil(24 / cutoff)
    const result = new Float32Array(Math.ceil((end - start) * SAMPLE_RATE))
    for (let i = 0; i < result.length; i++) {
        const at = i * ratio
        let sum = 0, weight = 0
        for (let j = Math.ceil(at - radius); j <= Math.floor(at + radius); j++) {
            if (j < 0 || j >= mono.length) {continue}
            const distance = j - at, x = Math.PI * cutoff * distance
            const w = cutoff * (Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x)
                * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius))
            sum += mono[j] * w
            weight += w
        }
        result[i] = weight === 0 ? 0 : sum / weight
    }
    return result
}

const reflect = (index: number, length: number): number => {
    if (index < 0) {return -index}
    if (index >= length) {return 2 * length - 2 - index}
    return index
}

/** Matches the export: periodic Hann, centered/reflected STFT, magnitude, HTK mel, natural log. */
export const muScriptorLogMel = (audio: Float32Array): {data: Float32Array, frames: number} => {
    if (audio.length !== CHUNK_SAMPLES) {throw new Error("MuScriptor requires padded five-second chunks")}
    const frames = 1 + Math.floor(audio.length / HOP)
    const fft = new FFT(FFT_SIZE), real = new Float32Array(FFT_SIZE), imag = new Float32Array(FFT_SIZE)
    const magnitude = new Float32Array(FFT_SIZE / 2 + 1)
    const window = Float32Array.from({length: FFT_SIZE}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_SIZE))
    const maxMel = 2595 * Math.log10(1 + SAMPLE_RATE / 2 / 700)
    const frequencies = Array.from({length: MELS + 2}, (_, i) => 700 * (10 ** (i * maxMel / (MELS + 1) / 2595) - 1))
    const filters = Array.from({length: MELS}, (_, mel) => {
        const left = frequencies[mel], center = frequencies[mel + 1], right = frequencies[mel + 2]
        const weights: Array<[number, number]> = []
        for (let bin = Math.ceil(left * FFT_SIZE / SAMPLE_RATE); bin < Math.min(magnitude.length, Math.ceil(right * FFT_SIZE / SAMPLE_RATE)); bin++) {
            const hz = bin * SAMPLE_RATE / FFT_SIZE
            const weight = Math.max(0, Math.min((hz - left) / (center - left), (right - hz) / (right - center)))
            if (weight > 0) {weights.push([bin, weight])}
        }
        return weights
    })
    const data = new Float32Array(frames * MELS)
    for (let frame = 0; frame < frames; frame++) {
        for (let i = 0; i < FFT_SIZE; i++) {
            real[i] = audio[reflect(frame * HOP + i - FFT_SIZE / 2, audio.length)] * window[i]
        }
        imag.fill(0)
        fft.process(real, imag)
        for (let bin = 0; bin < magnitude.length; bin++) {magnitude[bin] = Math.hypot(real[bin], imag[bin])}
        for (let mel = 0; mel < MELS; mel++) {
            let sum = 0
            for (const [bin, weight] of filters[mel]) {sum += magnitude[bin] * weight}
            data[frame * MELS + mel] = Math.log(sum + 1e-6)
        }
    }
    return {data, frames}
}
