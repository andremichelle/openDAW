import {Arrays, Class, isDefined, panic, Progress, tryCatch, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {AudioData, estimateBpm} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {SamplePeaks} from "@opendaw/lib-fusion"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {AssetService} from "../AssetService"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
import {WavFile} from "@opendaw/lib-dsp"
import {Workers} from "../Workers"
import {SampleStorage} from "./SampleStorage"
import {FactoryCatalog} from "../FactoryCatalog"

export class SampleService extends AssetService<Sample, AudioData> {
    protected readonly namePlural: string = "Samples"
    protected readonly nameSingular: string = "Sample"
    protected readonly boxType: Class<Box> = AudioFileBox
    protected readonly filePickerOptions: FilePickerOptions = FilePickerAcceptTypes.WavFiles

    constructor(readonly audioContext: AudioContext) {super()}

    async importRecording(audioData: AudioData, bpm: number, name: string = "Recording"): Promise<Sample> {
        // A sample MUST have a positive length. A zero-frame take would become a duration-0 sample and, once
        // dropped, a duration-0 region that later trips validateTrack ("duration must be positive"). Reject it
        // at the door so the invariant "every sample has duration > 0" holds for every downstream consumer.
        if (audioData.numberOfFrames === 0) {
            return panic(`Cannot import recording '${name}': the take is empty (0 frames).`)
        }
        const arrayBuffer = WavFile.encodeFloats({
            frames: audioData.frames.slice(),
            numberOfFrames: audioData.numberOfFrames,
            numberOfChannels: audioData.numberOfChannels,
            sampleRate: audioData.sampleRate
        })
        return this.importFile({name, bpm, arrayBuffer, origin: "recording"})
    }

    async importFile({uuid, name, bpm, arrayBuffer, progressHandler = Progress.Empty, origin = "import"}
                     : AssetService.ImportArgs,
                     transformMeta?: (meta: SampleMetaData, audioData: Readonly<AudioData>) => Promise<void>): Promise<Sample> {
        console.debug(`importSample '${name}' (${arrayBuffer.byteLength >> 10}kb)`)
        uuid ??= await UUID.sha256(arrayBuffer)
        const audioData = await this.#decodeAudio(arrayBuffer)
        // Empty/undecodable audio yields 0 frames -> duration 0. Such a sample creates duration-0 regions that
        // later panic in validateTrack. Enforce "a sample has duration > 0" here, the single source of every
        // audio region, instead of guarding every consumer downstream.
        if (audioData.numberOfFrames === 0) {
            return panic(`Cannot import '${name}': the audio is empty (0 frames).`)
        }
        const duration = audioData.numberOfFrames / audioData.sampleRate
        const shifts = SamplePeaks.findBestFit(audioData.numberOfFrames)
        const peaks = await Workers.Peak.generateAsync(
            progressHandler,
            shifts,
            audioData.frames,
            audioData.numberOfFrames,
            audioData.numberOfChannels) as ArrayBuffer
        const meta: SampleMetaData = {
            bpm: bpm ?? estimateBpm(duration),
            name: name ?? "Unnnamed",
            duration,
            sample_rate: audioData.sampleRate,
            origin
        }
        if (isDefined(transformMeta)) {
            await transformMeta(meta, audioData)
        }
        const sample = {uuid: UUID.toString(uuid), ...meta}
        await SampleStorage.get().save({uuid, audio: audioData, peaks, meta})
        this.notifier.notify([sample, audioData])
        return sample
    }

    protected async collectAllFiles(): Promise<ReadonlyArray<Sample>> {
        const stock = await FactoryCatalog.get().samples()
        const local = await SampleStorage.get().list()
        return Arrays.merge(stock, local, (sample, {uuid}) => sample.uuid === uuid)
    }

    async #decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioData> {
        const wavResult = tryCatch(() => WavFile.decodeFloats(arrayBuffer))
        if (wavResult.status === "success") {return wavResult.value}
        console.debug("decoding with web-api-api (fallback)")
        const {status, value: audioBuffer} = await Promises.tryCatch(this.audioContext.decodeAudioData(arrayBuffer))
        if (status === "rejected") {return Promise.reject(new Error("Could not decode audio file"))}
        const audioData = AudioData.create(audioBuffer.sampleRate, audioBuffer.length, audioBuffer.numberOfChannels)
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            audioData.frames[channel].set(audioBuffer.getChannelData(channel))
        }
        return audioData
    }
}