import {ByteArrayInput, EmptyExec, Lazy, UUID} from "@opendaw/lib-std"
import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {Workers} from "../Workers"
import {WavFile} from "../WavFile"
import {Storage} from "../Storage"
import {AudioData} from "@opendaw/lib-dsp"

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

    async updateSampleMeta(uuid: UUID.Bytes, meta: SampleMetaData): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        return Workers.Opfs.write(`${path}/meta.json`, new TextEncoder().encode(JSON.stringify(meta)))
    }

    async load(uuid: UUID.Bytes): Promise<[AudioData, Peaks, SampleMetaData]> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        return Promise.all([
            Workers.Opfs.read(`${path}/audio.wav`)
                .then(bytes => WavFile.decodeFloats(bytes.buffer as ArrayBuffer)),
            Workers.Opfs.read(`${path}/peaks.bin`)
                .then(bytes => SamplePeaks.from(new ByteArrayInput(bytes.buffer))),
            Workers.Opfs.read(`${path}/meta.json`)
                .then(bytes => JSON.parse(new TextDecoder().decode(bytes)))
        ]).then(([buffer, peaks, meta]) => [{
            sampleRate: buffer.sampleRate,
            numberOfFrames: buffer.numberOfFrames,
            numberOfChannels: buffer.frames.length,
            frames: buffer.frames
        }, peaks, meta])
    }
}
