import {ByteArrayInput, EmptyExec, Lazy, Progress, tryCatch, UUID} from "@opendaw/lib-std"
import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {Workers} from "../Workers"
import {Storage} from "../Storage"
import {AudioData, WavFile} from "@opendaw/lib-dsp"

export namespace SampleStorage {
    export type NewSample = {
        uuid: UUID.Bytes,
        audio: AudioData,
        peaks: ArrayBuffer,
        meta: SampleMetaData
    }
}

export class SampleStorage extends Storage<Sample, SampleMetaData, SampleStorage.NewSample, [AudioData, Peaks, SampleMetaData]> {
    static readonly Folder = "samples/v2"

    @Lazy
    static get(): SampleStorage {return new SampleStorage()}

    private constructor() {super(SampleStorage.Folder)}

    async save({uuid, audio, peaks, meta}: SampleStorage.NewSample): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const data = new Uint8Array(WavFile.encodeFloats({
            frames: audio.frames.slice(),
            numberOfFrames: audio.numberOfFrames,
            numberOfChannels: audio.numberOfChannels,
            sampleRate: audio.sampleRate
        }))
        console.debug(`save sample '${path}'`)
        return Promise.all([
            Workers.Opfs.write(`${path}/audio.wav`, data),
            Workers.Opfs.write(`${path}/peaks.bin`, new Uint8Array(peaks)),
            Workers.Opfs.write(`${path}/meta.json`, new TextEncoder().encode(JSON.stringify(meta)))
        ]).then(EmptyExec)
    }

    async exists(uuid: UUID.Bytes): Promise<boolean> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        return Workers.Opfs.exists(path)
    }

    async updateSampleMeta(uuid: UUID.Bytes, meta: SampleMetaData): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        return Workers.Opfs.write(`${path}/meta.json`, new TextEncoder().encode(JSON.stringify(meta)))
    }

    async load(uuid: UUID.Bytes): Promise<[AudioData, Peaks, SampleMetaData]> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const [audioBytes, peaksBytes, metaBytes] = await Promise.all([
            Workers.Opfs.read(`${path}/audio.wav`),
            Workers.Opfs.read(`${path}/peaks.bin`),
            Workers.Opfs.read(`${path}/meta.json`)
        ])
        const decoded = WavFile.decodeFloats(exactBuffer(audioBytes))
        const audio: AudioData = {
            sampleRate: decoded.sampleRate,
            numberOfFrames: decoded.numberOfFrames,
            numberOfChannels: decoded.frames.length,
            frames: decoded.frames
        }
        const peaks = await this.#readOrRegeneratePeaks(path, peaksBytes, audio, exactBuffer)
        const meta: SampleMetaData = JSON.parse(new TextDecoder().decode(metaBytes))
        return [audio, peaks, meta]
    }

    async #readOrRegeneratePeaks(path: string,
                                 bytes: Uint8Array,
                                 audio: AudioData,
                                 exactBuffer: (bytes: Uint8Array) => ArrayBuffer): Promise<Peaks> {
        if (bytes.byteLength > 0) {
            const attempt = tryCatch(() => SamplePeaks.from(new ByteArrayInput(exactBuffer(bytes))))
            if (attempt.status === "success") {return attempt.value}
            console.warn(`peaks.bin is corrupted for '${path}' — regenerating`, attempt.error)
        } else {
            console.warn(`peaks.bin is empty for '${path}' — regenerating`)
        }
        const shifts = SamplePeaks.findBestFit(audio.numberOfFrames)
        const regenerated = await Workers.Peak.generateAsync(
            Progress.Empty, shifts, audio.frames, audio.numberOfFrames, audio.numberOfChannels) as ArrayBuffer
        await Workers.Opfs.write(`${path}/peaks.bin`, new Uint8Array(regenerated))
        return SamplePeaks.from(new ByteArrayInput(regenerated))
    }
}
