import {Arrays, Class, isUndefined, Procedure, Progress, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {AudioData, estimateBpm} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {SamplePeaks} from "@opendaw/lib-fusion"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {AssetService} from "../AssetService"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
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
        console.time("UUID.sha256")
        uuid ??= await UUID.sha256(arrayBuffer) // Must run before decodeAudioData laster, because it will detach the ArrayBuffer
        console.timeEnd("UUID.sha256")
        console.time("decodeAudioData")
        const audioResult = await Promises.tryCatch(this.audioContext.decodeAudioData(arrayBuffer))
        console.timeEnd("decodeAudioData")
        if (audioResult.status === "rejected") {return Promise.reject(name)}
        const {value: audioBuffer} = audioResult
        console.debug(`Imported ${audioBuffer.duration.toFixed(1)} seconds`)
        const audioData = AudioData.create(audioBuffer.sampleRate, audioBuffer.length, audioBuffer.numberOfChannels)
        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
            audioData.frames[i].set(audioBuffer.getChannelData(i))
        }
        const shifts = SamplePeaks.findBestFit(audioData.numberOfFrames)
        const peaks = await Workers.Peak.generateAsync(
            progressHandler,
            shifts,
            audioData.frames,
            audioData.numberOfFrames,
            audioData.numberOfChannels) as ArrayBuffer
        const meta: SampleMetaData = {
            bpm: estimateBpm(audioBuffer.duration),
            name: isUndefined(name) ? "Unnnamed" : name,
            duration: audioBuffer.duration,
            sample_rate: audioBuffer.sampleRate,
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
}