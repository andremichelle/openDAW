import {Arrays, Class, isUndefined, Procedure, Progress, tryCatch, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {AudioData, estimateBpm} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {SamplePeaks} from "@opendaw/lib-fusion"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {AssetService} from "../AssetService"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
import {WavFile} from "../WavFile"
import {Workers} from "../Workers"
import {SampleStorage} from "./SampleStorage"
import {OpenSampleAPI} from "./OpenSampleAPI"

export class SampleService extends AssetService<Sample> {
    protected readonly namePlural: string = "Samples"
    protected readonly nameSingular: string = "Sample"
    protected readonly boxType: Class<Box> = AudioFileBox
    protected readonly filePickerOptions: FilePickerOptions = FilePickerAcceptTypes.WavFiles

    constructor(readonly audioContext: AudioContext, onUpdate: Procedure<Sample>) {
        super(onUpdate)
    }

    async importFile({uuid, name, arrayBuffer, progressHandler = Progress.Empty}
                     : AssetService.ImportArgs): Promise<Sample> {
        console.debug(`importSample '${name}' (${arrayBuffer.byteLength >> 10}kb)`)
        uuid ??= await UUID.sha256(arrayBuffer)
        const audioData = await this.#decodeAudio(arrayBuffer)
        const duration = audioData.numberOfFrames / audioData.sampleRate
        const shifts = SamplePeaks.findBestFit(audioData.numberOfFrames)
        const peaks = await Workers.Peak.generateAsync(
            progressHandler,
            shifts,
            audioData.frames,
            audioData.numberOfFrames,
            audioData.numberOfChannels) as ArrayBuffer
        const meta: SampleMetaData = {
            bpm: estimateBpm(duration),
            name: isUndefined(name) ? "Unnnamed" : name,
            duration,
            sample_rate: audioData.sampleRate,
            origin: "import"
        }
        await SampleStorage.get().save({uuid, audio: audioData, peaks, meta})
        const sample = {uuid: UUID.toString(uuid), ...meta}
        this.onUpdate(sample)
        return sample
    }

    protected async collectAllFiles(): Promise<ReadonlyArray<Sample>> {
        const stock = await OpenSampleAPI.get().all()
        const local = await SampleStorage.get().list()
        return Arrays.merge(stock, local, (sample, {uuid}) => sample.uuid === uuid)
    }

    async #decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioData> {
        const wavResult = tryCatch(() => WavFile.decodeFloats(arrayBuffer))
        if (wavResult.status === "success") {return wavResult.value}
        console.debug("decoding with web-api-api (fallback)")
        const {status, value: audioBuffer} = await Promises.tryCatch(this.audioContext.decodeAudioData(arrayBuffer))
        if (status === "rejected") {return Promise.reject()}
        const audioData = AudioData.create(audioBuffer.sampleRate, audioBuffer.length, audioBuffer.numberOfChannels)
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            audioData.frames[channel].set(audioBuffer.getChannelData(channel))
        }
        return audioData
    }
}