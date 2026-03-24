import {describe, expect, it} from "vitest"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleMetaData, SoundfontMetaData} from "@opendaw/studio-adapters"
import {AssetZip, type WavDecoder} from "../AssetZip"

const createTestAudioData = (): AudioData => {
    const audioData = AudioData.create(44100, 128, 2)
    for (let channel = 0; channel < 2; channel++) {
        for (let frame = 0; frame < 128; frame++) {
            audioData.frames[channel][frame] = Math.sin(frame / 10) * 0.5
        }
    }
    return audioData
}

const encodeWav = (audio: AudioData): ArrayBuffer => {
    const bytesPerSample = 4
    const dataSize = audio.numberOfFrames * audio.numberOfChannels * bytesPerSample
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)
    view.setUint32(0, 0x46464952, true)  // RIFF
    view.setUint32(4, 36 + dataSize, true)
    view.setUint32(8, 0x45564157, true)  // WAVE
    view.setUint32(12, 0x20746d66, true) // fmt
    view.setUint32(16, 16, true)
    view.setUint16(20, 3, true)          // IEEE float
    view.setUint16(22, audio.numberOfChannels, true)
    view.setUint32(24, audio.sampleRate, true)
    view.setUint32(28, audio.sampleRate * audio.numberOfChannels * bytesPerSample, true)
    view.setUint16(32, audio.numberOfChannels * bytesPerSample, true)
    view.setUint16(34, 32, true)         // bits per sample
    view.setUint32(36, 0x61746164, true) // data
    view.setUint32(40, dataSize, true)
    let offset = 44
    for (let frame = 0; frame < audio.numberOfFrames; frame++) {
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            view.setFloat32(offset, audio.frames[channel][frame], true)
            offset += bytesPerSample
        }
    }
    return buffer
}

const decodeWav: WavDecoder = (buffer: ArrayBuffer): AudioData => {
    const view = new DataView(buffer)
    const numberOfChannels = view.getUint16(22, true)
    const sampleRate = view.getUint32(24, true)
    const dataSize = view.getUint32(40, true)
    const numberOfFrames = dataSize / (numberOfChannels * 4)
    const audioData = AudioData.create(sampleRate, numberOfFrames, numberOfChannels)
    let offset = 44
    for (let frame = 0; frame < numberOfFrames; frame++) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
            audioData.frames[channel][frame] = view.getFloat32(offset, true)
            offset += 4
        }
    }
    return audioData
}

const createTestSampleMeta = (): SampleMetaData => ({
    name: "test-sample.wav",
    bpm: 120,
    duration: 128 / 44100,
    sample_rate: 44100,
    origin: "import"
})

const createTestSoundfontMeta = (): SoundfontMetaData => ({
    name: "test-soundfont.sf2",
    size: 1024,
    url: "",
    license: "CC0",
    origin: "import"
})

describe("AssetZip", () => {
    describe("sample pack/unpack", () => {
        it("roundtrips audio data and metadata", async () => {
            const audioData = createTestAudioData()
            const meta = createTestSampleMeta()
            const wavBytes = encodeWav(audioData)
            const zipBytes = await AssetZip.packSample(wavBytes, meta)
            const [resultAudio, resultMeta] = await AssetZip.unpackSample(zipBytes, decodeWav)
            expect(resultMeta).toEqual(meta)
            expect(resultAudio.sampleRate).toBe(audioData.sampleRate)
            expect(resultAudio.numberOfFrames).toBe(audioData.numberOfFrames)
            expect(resultAudio.numberOfChannels).toBe(audioData.numberOfChannels)
            for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
                for (let frame = 0; frame < audioData.numberOfFrames; frame++) {
                    expect(resultAudio.frames[channel][frame]).toBeCloseTo(audioData.frames[channel][frame], 5)
                }
            }
        })
        it("preserves optional custom field in metadata", async () => {
            const meta: SampleMetaData = {...createTestSampleMeta(), custom: "user-tag"}
            const wavBytes = encodeWav(createTestAudioData())
            const zipBytes = await AssetZip.packSample(wavBytes, meta)
            const [, resultMeta] = await AssetZip.unpackSample(zipBytes, decodeWav)
            expect(resultMeta.custom).toBe("user-tag")
        })
    })
    describe("soundfont pack/unpack", () => {
        it("roundtrips sf2 bytes and metadata", async () => {
            const sf2Bytes = new ArrayBuffer(1024)
            const view = new Uint8Array(sf2Bytes)
            for (let index = 0; index < view.length; index++) {
                view[index] = index & 0xFF
            }
            const meta = createTestSoundfontMeta()
            const zipBytes = await AssetZip.packSoundfont(sf2Bytes, meta)
            const [resultSf2, resultMeta] = await AssetZip.unpackSoundfont(zipBytes)
            expect(resultMeta).toEqual(meta)
            expect(new Uint8Array(resultSf2)).toEqual(view)
        })
        it("handles large sf2 files", async () => {
            const size = 256 * 1024
            const sf2Bytes = new ArrayBuffer(size)
            new Uint8Array(sf2Bytes).fill(0xAB)
            const meta = {...createTestSoundfontMeta(), size}
            const zipBytes = await AssetZip.packSoundfont(sf2Bytes, meta)
            const [resultSf2] = await AssetZip.unpackSoundfont(zipBytes)
            expect(resultSf2.byteLength).toBe(size)
            expect(new Uint8Array(resultSf2).every(byte => byte === 0xAB)).toBe(true)
        })
    })
})
