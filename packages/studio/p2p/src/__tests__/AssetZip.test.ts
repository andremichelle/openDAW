import {describe, expect, it} from "vitest"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {SampleMetaData, SoundfontMetaData} from "@opendaw/studio-adapters"
import {AssetZip} from "../AssetZip"

const createTestAudioData = (): AudioData => {
    const audioData = AudioData.create(44100, 128, 2)
    for (let channel = 0; channel < 2; channel++) {
        for (let frame = 0; frame < 128; frame++) {
            audioData.frames[channel][frame] = Math.sin(frame / 10) * 0.5
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
            const wavBytes = WavFile.encodeFloats(audioData)
            const zipBytes = await AssetZip.packSample(wavBytes, meta)
            const [resultAudio, resultMeta] = await AssetZip.unpackSample(zipBytes)
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
            const wavBytes = WavFile.encodeFloats(createTestAudioData())
            const zipBytes = await AssetZip.packSample(wavBytes, meta)
            const [, resultMeta] = await AssetZip.unpackSample(zipBytes)
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
