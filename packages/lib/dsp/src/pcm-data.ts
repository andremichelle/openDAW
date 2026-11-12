import {Arrays, int} from "@opendaw/lib-std"
import {AudioData, AudioInfo} from "./audio-data"

// Sample frames in the format they are stored in: 32 bit float, or 16 bit PCM when nothing is lost by it.
export type PcmData = AudioInfo & (
    | { format: "float32", frames: ReadonlyArray<Float32Array<SharedArrayBuffer>> }
    | { format: "int16", frames: ReadonlyArray<Int16Array<SharedArrayBuffer>> })

export namespace PcmData {
    export type Measure = { readonly exact16: boolean, readonly peak: number }

    const Scale = 32768

    export const createInt16 = (numberOfFrames: int, numberOfChannels: int): ReadonlyArray<Int16Array<SharedArrayBuffer>> => {
        const bytesPerChannel = numberOfFrames * Int16Array.BYTES_PER_ELEMENT
        const buffer = new SharedArrayBuffer(bytesPerChannel * numberOfChannels)
        return Arrays.create(index => new Int16Array(buffer, index * bytesPerChannel, numberOfFrames), numberOfChannels)
    }

    // -0 would come back as +0, so it does not count as exact
    const exact = (value: number): boolean => {
        if (value === 0.0) {return 1.0 / value > 0.0}
        const scaled = value * Scale
        return scaled === Math.trunc(scaled) && scaled >= -Scale && scaled < Scale
    }

    // every value survives 16 bit PCM bit for bit
    export const isExact16 = ({frames, numberOfFrames}: AudioData): boolean => {
        for (const channel of frames) {
            for (let frame = 0; frame < numberOfFrames; frame++) {
                if (!exact(channel[frame])) {return false}
            }
        }
        return true
    }

    export const measure = ({frames, numberOfFrames}: AudioData): Measure => {
        let exact16 = true
        let peak = 0.0
        for (const channel of frames) {
            for (let frame = 0; frame < numberOfFrames; frame++) {
                const value = channel[frame]
                const magnitude = Math.abs(value)
                if (magnitude > peak) {peak = magnitude} else if (magnitude !== magnitude) {peak = Number.POSITIVE_INFINITY}
                if (exact16 && !exact(value)) {exact16 = false}
            }
        }
        return {exact16, peak}
    }

    // 16 bit when every value is exact in it, else the float frames as they are (shared, not copied)
    export const smallest = (audio: AudioData): PcmData => {
        if (!isExact16(audio)) {return {format: "float32", ...audio}}
        return quantize(audio, 1.0)
    }

    // frames scaled by gain and rounded to 16 bit, what is beyond full scale is clipped
    export const quantize = ({sampleRate, numberOfFrames, numberOfChannels, frames}: AudioData, gain: number): PcmData => {
        const target = createInt16(numberOfFrames, numberOfChannels)
        frames.forEach((channel, index) => {
            const plane = target[index]
            for (let frame = 0; frame < numberOfFrames; frame++) {
                plane[frame] = Math.max(-Scale, Math.min(Scale - 1, Math.round(channel[frame] * gain * Scale)))
            }
        })
        return {format: "int16", sampleRate, numberOfFrames, numberOfChannels, frames: target}
    }

    // the frames as floats: float frames as they are, 16 bit frames as a 16 bit WAV decodes them
    export const floats = (pcm: PcmData): AudioData => {
        const {sampleRate, numberOfFrames, numberOfChannels} = pcm
        if (pcm.format === "float32") {return {sampleRate, numberOfFrames, numberOfChannels, frames: pcm.frames}}
        const audio = AudioData.create(sampleRate, numberOfFrames, numberOfChannels)
        pcm.frames.forEach((plane, index) => {
            const channel = audio.frames[index]
            for (let frame = 0; frame < numberOfFrames; frame++) {channel[frame] = plane[frame] / Scale}
        })
        return audio
    }

    export const byteLength = ({format, numberOfFrames, numberOfChannels}: PcmData): number =>
        numberOfFrames * numberOfChannels * (format === "int16" ? 2 : 4)
}
