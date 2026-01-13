import {Arrays, int, panic} from "@moises-ai/lib-std"
import {AudioData} from "@moises-ai/lib-dsp"

export namespace WavFile {
    const MAGIC_RIFF = 0x46464952
    const MAGIC_WAVE = 0x45564157
    const MAGIC_FMT = 0x20746d66
    const MAGIC_DATA = 0x61746164

    export const decodeFloats = (buffer: ArrayBuffer): AudioData => {
        const view = new DataView(buffer)
        if (view.getUint32(0, true) !== MAGIC_RIFF
            || view.getUint32(8, true) !== MAGIC_WAVE) {
            return panic("Not a RIFF/WAVE file")
        }
        let fmtOffset = -1
        let dataOffset = -1
        let dataSize = 0
        for (let o = 12; o + 8 <= view.byteLength;) {
            const id = view.getUint32(o, true)
            const size = view.getUint32(o + 4, true)
            const next = o + 8 + ((size + 1) & ~1)
            if (id === MAGIC_FMT) fmtOffset = o + 8
            if (id === MAGIC_DATA) {
                dataOffset = o + 8
                dataSize = size
            }
            o = next
        }
        if (fmtOffset < 0 || dataOffset < 0) {
            return panic("Missing fmt or data chunk")
        }
        const audioFormat = view.getUint16(fmtOffset, true)  // 1 = PCM, 3 = IEEE float
        const numberOfChannels = view.getUint16(fmtOffset + 2, true)
        const sampleRate = view.getUint32(fmtOffset + 4, true)
        const blockAlign = view.getUint16(fmtOffset + 12, true)
        const bitsPerSample = view.getUint16(fmtOffset + 14, true)
        const bytesPerSample = bitsPerSample / 8
        if (blockAlign !== numberOfChannels * bytesPerSample) {
            return panic("Invalid block alignment")
        }
        const numberOfFrames = Math.floor(dataSize / blockAlign)
        const audioData = AudioData.create(sampleRate, numberOfFrames, numberOfChannels)
        if (audioFormat === 3 && bitsPerSample === 32) {
            // 32-bit float
            const interleaved = new Float32Array(buffer, dataOffset, numberOfFrames * numberOfChannels)
            for (let i = 0, w = 0; i < numberOfFrames; i++) {
                for (let c = 0; c < numberOfChannels; c++) {
                    audioData.frames[c][i] = interleaved[w++]
                }
            }
        } else if (audioFormat === 1 && bitsPerSample === 16) {
            // 16-bit PCM
            for (let i = 0, offset = dataOffset; i < numberOfFrames; i++) {
                for (let c = 0; c < numberOfChannels; c++) {
                    audioData.frames[c][i] = view.getInt16(offset, true) / 32768
                    offset += 2
                }
            }
        } else if (audioFormat === 1 && bitsPerSample === 24) {
            // 24-bit PCM
            for (let i = 0, offset = dataOffset; i < numberOfFrames; i++) {
                for (let c = 0; c < numberOfChannels; c++) {
                    const low = view.getUint16(offset, true)
                    const high = view.getInt8(offset + 2)
                    audioData.frames[c][i] = (high * 65536 + low) / 8388608
                    offset += 3
                }
            }
        } else {
            return panic(`Unsupported WAV format: ${audioFormat}, ${bitsPerSample}-bit`)
        }
        return audioData
    }

    export const encodeFloats = (audio: AudioData | AudioBuffer, maxLength: int = Number.MAX_SAFE_INTEGER): ArrayBuffer => {
        const bytesPerChannel = Float32Array.BYTES_PER_ELEMENT
        const sampleRate = audio.sampleRate
        let numberOfFrames: number
        let numberOfChannels: number
        let frames: ReadonlyArray<Float32Array>
        if (audio instanceof AudioBuffer) {
            frames = Arrays.create(index => audio.getChannelData(index), audio.numberOfChannels)
            numberOfFrames = audio.length
            numberOfChannels = audio.numberOfChannels
        } else {
            frames = audio.frames
            numberOfFrames = audio.numberOfFrames
            numberOfChannels = audio.frames.length
        }
        numberOfFrames = Math.min(maxLength, numberOfFrames)
        const size = 44 + numberOfFrames * numberOfChannels * bytesPerChannel
        const buf = new ArrayBuffer(size)
        const view = new DataView(buf)
        view.setUint32(0, MAGIC_RIFF, true)
        view.setUint32(4, size - 8, true)
        view.setUint32(8, MAGIC_WAVE, true)
        view.setUint32(12, MAGIC_FMT, true)
        view.setUint32(16, 16, true) // chunk length
        view.setUint16(20, 3, true) // compression
        view.setUint16(22, numberOfChannels, true)
        view.setUint32(24, sampleRate, true)
        view.setUint32(28, sampleRate * numberOfChannels * bytesPerChannel, true)
        view.setUint16(32, numberOfChannels * bytesPerChannel, true)
        view.setUint16(34, 8 * bytesPerChannel, true)
        view.setUint32(36, MAGIC_DATA, true)
        view.setUint32(40, numberOfChannels * numberOfFrames * bytesPerChannel, true)
        let w = 44
        for (let i = 0; i < numberOfFrames; ++i) {
            for (let j = 0; j < numberOfChannels; ++j) {
                view.setFloat32(w, frames[j][i], true)
                w += bytesPerChannel
            }
        }
        return view.buffer
    }
}