import {DefaultObservableValue, Option, Progress} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {OfflineEngineRenderer, OpusEncoder, Project} from "@opendaw/studio-core"

export namespace OpusMixdown {
    export type Encoder = "webcodecs" | "ffmpeg"

    export type Encoded = Readonly<{ bytes: ArrayBuffer, encoder: Encoder }>

    export const render = async (project: Project, progress: Progress.Handler): Promise<AudioData> => {
        const renderValue = new DefaultObservableValue(0.0)
        const subscription = renderValue.subscribe(owner => progress(owner.getValue()))
        return OfflineEngineRenderer.start(project.copy(), Option.None, renderValue, undefined, OpusEncoder.SampleRate)
            .finally(() => subscription.terminate())
    }

    export const encode = async (audio: AudioData, settings: OpusEncoder.Settings,
                                 progress: Progress.Handler): Promise<Encoded> => {
        if (await OpusEncoder.isSupported(settings)) {
            return {bytes: await OpusEncoder.encode(audio, settings, progress), encoder: "webcodecs"}
        }
        const [loadProgress, convertProgress] = Progress.split(progress, 2)
        const {FFmpegWorker} = await Promises.guardedRetry(() =>
            import("@opendaw/studio-core/FFmpegWorker"), (_, count) => count < 10)
        const worker = await FFmpegWorker.load(loadProgress)
        const bytes = await worker.opusConverter().convert(new Blob([WavFile.encodeFloats(audio)]), convertProgress,
            {bitrate: settings.bitrate, complexity: settings.complexity})
        return {bytes, encoder: "ffmpeg"}
    }
}
