import {ByteArrayInput, EmptyExec, Lazy, Progress, Provider, tryCatch, UUID} from "@opendaw/lib-std"
import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {Workers} from "../Workers"
import {Storage} from "../Storage"
import {AudioData, PcmData, SampleConversion, WavFile} from "@opendaw/lib-dsp"

const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

export namespace SampleStorage {
    export type NewSample = {
        uuid: UUID.Bytes,
        audio: AudioData,
        peaks: ArrayBuffer,
        meta: SampleMetaData
    }
    // "smallest" writes 16 bit PCM for a sample that loses nothing by it
    export type Format = "float32" | "smallest"
}

export class SampleStorage extends Storage<Sample, SampleMetaData, SampleStorage.NewSample, [AudioData, Peaks, SampleMetaData]> {
    static readonly Folder = "samples/v2"
    // the new frames of a sample while its audio file is being replaced
    static readonly Pending = "audio.wav.pending"
    // exists once the pending file is complete: from then on it is the truth
    static readonly Commit = "audio.wav.commit"

    @Lazy
    static get(): SampleStorage {return new SampleStorage()}

    format: SampleStorage.Format = "float32"

    private constructor() {super(SampleStorage.Folder)}

    async save(sample: SampleStorage.NewSample): Promise<void> {return this.store(sample).then(EmptyExec)}

    // saves the sample and returns the frames as they were written
    async store({uuid, audio, peaks, meta}: SampleStorage.NewSample): Promise<PcmData> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const floats: AudioData = {
            frames: audio.frames.slice(),
            numberOfFrames: audio.numberOfFrames,
            numberOfChannels: audio.numberOfChannels,
            sampleRate: audio.sampleRate
        }
        const pcm: PcmData = this.format === "smallest" ? PcmData.smallest(floats) : {format: "float32", ...floats}
        const data = new Uint8Array(pcm.format === "int16" ? WavFile.encodePcm(pcm) : WavFile.encodeFloats(floats))
        console.debug(`save sample '${path}'`)
        return Promise.all([
            Workers.Opfs.write(`${path}/audio.wav`, data),
            Workers.Opfs.write(`${path}/peaks.bin`, new Uint8Array(peaks)),
            Workers.Opfs.write(`${path}/meta.json`, new TextEncoder().encode(JSON.stringify(meta)))
        ]).then(() => pcm)
    }

    async exists(uuid: UUID.Bytes): Promise<boolean> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        return Workers.Opfs.exists(path)
    }

    async updateSampleMeta(uuid: UUID.Bytes, meta: SampleMetaData): Promise<void> {
        return this.updateMeta(uuid, meta)
    }

    async loadMeta(uuid: UUID.Bytes): Promise<SampleMetaData> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const bytes = await Workers.Opfs.read(`${path}/meta.json`)
        return JSON.parse(new TextDecoder().decode(bytes))
    }

    async loadPeaks(uuid: UUID.Bytes, audio: AudioData): Promise<Peaks> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const bytes = await Workers.Opfs.read(`${path}/peaks.bin`)
        return this.#readOrRegeneratePeaks(path, bytes, () => audio)
    }

    // the frames as they are stored, 16 bit stays 16 bit
    async loadPcm(uuid: UUID.Bytes): Promise<PcmData> {
        return WavFile.decodePcm(exactBuffer(await this.#audio(`${this.folder}/${UUID.toString(uuid)}`)))
    }

    // replaces the stored frames so that a page dying in the middle leaves a sample the next load completes
    async replaceAudio(uuid: UUID.Bytes, pcm: PcmData): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const bytes = new Uint8Array(WavFile.encodePcm(pcm))
        const written = async (file: string): Promise<boolean> => {
            const stored = await Workers.Opfs.read(file)
            if (stored.byteLength !== bytes.byteLength) {return false}
            for (let index = 0; index < bytes.byteLength; index++) {
                if (stored[index] !== bytes[index]) {return false}
            }
            return true
        }
        await Workers.Opfs.write(`${path}/${SampleStorage.Pending}`, bytes)
        if (!await written(`${path}/${SampleStorage.Pending}`)) {
            await Workers.Opfs.delete(`${path}/${SampleStorage.Pending}`)
            return Promise.reject(new Error("The new audio file could not be written"))
        }
        await Workers.Opfs.write(`${path}/${SampleStorage.Commit}`, new Uint8Array([1]))
        await Workers.Opfs.write(`${path}/audio.wav`, bytes)
        if (!await written(`${path}/audio.wav`)) {return Promise.reject(new Error("The audio file could not be replaced"))}
        await Workers.Opfs.delete(`${path}/${SampleStorage.Commit}`)
        await Workers.Opfs.delete(`${path}/${SampleStorage.Pending}`)
    }

    // Rewrites a stored sample as 16 bit if it still is of the expected kind. Answers whether it was rewritten.
    async convert(uuid: UUID.Bytes, expected: SampleConversion.Kind): Promise<boolean> {
        const pcm = await this.loadPcm(uuid)
        if (SampleConversion.judge(pcm).kind !== expected) {return false}
        const converted = SampleConversion.convert(pcm)
        if (converted.isEmpty()) {return false}
        await this.replaceAudio(uuid, converted.unwrap())
        return true
    }

    // finishes or discards what a cut off replacement left behind
    async settle(uuid: UUID.Bytes): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        await this.#audio(path)
        if (await Workers.Opfs.exists(`${path}/${SampleStorage.Pending}`)) {
            await Workers.Opfs.delete(`${path}/${SampleStorage.Pending}`)
        }
    }

    async load(uuid: UUID.Bytes): Promise<[AudioData, Peaks, SampleMetaData]> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const [audioBytes, peaksBytes, metaBytes] = await Promise.all([
            this.#audio(path),
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
        const peaks = await this.#readOrRegeneratePeaks(path, peaksBytes, () => audio)
        const meta: SampleMetaData = JSON.parse(new TextDecoder().decode(metaBytes))
        return [audio, peaks, meta]
    }

    // as `load`, the frames left in the format they are stored in
    async loadStored(uuid: UUID.Bytes): Promise<[PcmData, Peaks, SampleMetaData]> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const [audioBytes, peaksBytes, metaBytes] = await Promise.all([
            this.#audio(path),
            Workers.Opfs.read(`${path}/peaks.bin`),
            Workers.Opfs.read(`${path}/meta.json`)
        ])
        const pcm = WavFile.decodePcm(exactBuffer(audioBytes))
        const peaks = await this.#readOrRegeneratePeaks(path, peaksBytes, () => PcmData.floats(pcm))
        const meta: SampleMetaData = JSON.parse(new TextDecoder().decode(metaBytes))
        return [pcm, peaks, meta]
    }

    // the bytes of the audio file, after completing a replacement that was cut off
    async #audio(path: string): Promise<Uint8Array> {
        const [bytes, committed] = await Promise.all([
            Workers.Opfs.read(`${path}/audio.wav`),
            Workers.Opfs.exists(`${path}/${SampleStorage.Commit}`)
        ])
        if (!committed) {return bytes}
        console.warn(`completing the replacement of '${path}/audio.wav'`)
        const pending = await Workers.Opfs.read(`${path}/${SampleStorage.Pending}`)
        await Workers.Opfs.write(`${path}/audio.wav`, pending)
        await Workers.Opfs.delete(`${path}/${SampleStorage.Commit}`)
        await Workers.Opfs.delete(`${path}/${SampleStorage.Pending}`)
        return pending
    }

    async #readOrRegeneratePeaks(path: string,
                                 bytes: Uint8Array,
                                 frames: Provider<AudioData>): Promise<Peaks> {
        if (bytes.byteLength > 0) {
            const attempt = tryCatch(() => SamplePeaks.from(new ByteArrayInput(exactBuffer(bytes))))
            if (attempt.status === "success") {return attempt.value}
            console.warn(`peaks.bin is corrupted for '${path}' — regenerating`, attempt.error)
        } else {
            console.warn(`peaks.bin is empty for '${path}' — regenerating`)
        }
        const audio = frames()
        const shifts = SamplePeaks.findBestFit(audio.numberOfFrames)
        const regenerated = await Workers.Peak.generateAsync(
            Progress.Empty, shifts, audio.frames, audio.numberOfFrames, audio.numberOfChannels) as ArrayBuffer
        await Workers.Opfs.write(`${path}/peaks.bin`, new Uint8Array(regenerated))
        return SamplePeaks.from(new ByteArrayInput(regenerated))
    }
}
