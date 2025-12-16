import {DefaultObservableValue, Errors, Option, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {
    AudioOfflineRenderer,
    AudioUtils,
    ExternalLib,
    FFmpegConverter,
    FFmpegWorker,
    ProjectMeta,
    ProjectProfile,
    WavFile
} from "@opendaw/studio-core"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {ExportStemsConfiguration} from "@opendaw/studio-adapters"
import {Dialogs} from "@/ui/components/dialogs"

export namespace Mixdowns {
    export const exportMixdown = async ({project, meta}: ProjectProfile): Promise<void> => {
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const result = await Promises.tryCatch(AudioOfflineRenderer
            .start(project, Option.None, x => progress.setValue(x), abortController.signal))
        dialog.terminate()
        if (result.status === "rejected") {
            if (!Errors.isAbort(result.error)) {
                throw result.error
            }
            return
        }
        const buffer: AudioBuffer = result.value
        const {resolve, reject, promise} = Promise.withResolvers<void>()
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Encode Mixdown",
            content: "openDAW will download FFmpeg (30MB) once to encode your mixdown unless you choose 'Wav'.",
            excludeOk: true,
            buttons: [
                {
                    text: "Mp3", onClick: handler => {
                        handler.close()
                        saveMp3File(buffer, meta).then(resolve, reject)
                    }, primary: false
                }, {
                    text: "Flac", onClick: handler => {
                        handler.close()
                        saveFlacFile(buffer, meta).then(resolve, reject)
                    }, primary: false
                }, {
                    text: "Wav", onClick: handler => {
                        handler.close()
                        saveWavFile(buffer, meta).then(resolve, reject)
                    }, primary: true
                }
            ]
        }))
        if (status === "rejected" && !Errors.isAbort(error)) {
            reject(error)
            return
        }
        return promise
    }

    export const exportStems = async ({project, meta}: ProjectProfile,
                                      config: ExportStemsConfiguration): Promise<void> => {
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const {status, value} = await Promises.tryCatch(AudioOfflineRenderer
            .start(project, Option.wrap(config), x => progress.setValue(x), abortController.signal))
        dialog.terminate()
        if (status === "rejected") {return}
        await saveZipFile(value, meta, Object.values(config).map(({fileName}) => fileName))
    }

    const saveWavFile = async (buffer: AudioBuffer, meta: ProjectMeta) => {
        const silentSample = AudioUtils.findLastNonSilentSample(buffer)
        return saveFileAfterAsync({
            buffer: WavFile.encodeFloats(buffer, silentSample),
            headline: "Save Wav",
            suggestedName: `${meta.name}.wav`
        })
    }

    const saveMp3File = async (buffer: AudioBuffer, meta: ProjectMeta) => {
        const ffmpeg = await loadFFmepg()
        return encodeAndSaveFile({
            converter: ffmpeg.mp3Converter(),
            fileExtension: "mp3",
            fileType: "Mp3",
            fileName: meta.name,
            buffer: buffer
        })
    }

    const saveFlacFile = async (buffer: AudioBuffer, meta: ProjectMeta) => {
        const ffmpeg = await loadFFmepg()
        return encodeAndSaveFile({
            converter: ffmpeg.flacConverter(),
            fileExtension: "flac",
            fileType: "Flac",
            fileName: meta.name,
            buffer: buffer
        })
    }

    const encodeAndSaveFile = async ({buffer, converter, fileType, fileExtension, fileName}: {
        buffer: AudioBuffer,
        converter: FFmpegConverter<unknown>,
        fileType: string,
        fileExtension: string,
        fileName: string
    }) => {
        const progress = new DefaultObservableValue(0.0)
        const progressDialog = RuntimeNotifier.progress({headline: `Encoding ${fileType}...`, progress})
        const silentSample = AudioUtils.findLastNonSilentSample(buffer)
        const flac = await converter.convert(new Blob([WavFile.encodeFloats(buffer, silentSample)]),
            value => progress.setValue(value))
        progressDialog.terminate()
        return saveFileAfterAsync({
            buffer: flac,
            headline: `Save ${fileType}`,
            suggestedName: `${fileName}.${fileExtension}`
        })
    }

    const saveZipFile = async (buffer: AudioBuffer, meta: ProjectMeta, trackNames: ReadonlyArray<string>) => {
        const libResult = await ExternalLib.JSZip()
        if (libResult.status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Error",
                message: `Could not load JSZip: ${String(libResult.error)}`
            })
            return Promise.reject(libResult.error)
        }
        const dialog = RuntimeNotifier.progress({headline: "Creating Zip File..."})
        const numStems = buffer.numberOfChannels >> 1
        const zip = new libResult.value()
        for (let stemIndex = 0; stemIndex < numStems; stemIndex++) {
            const l = buffer.getChannelData(stemIndex * 2)
            const r = buffer.getChannelData(stemIndex * 2 + 1)
            const file = WavFile.encodeFloats({
                frames: [l, r],
                sampleRate: buffer.sampleRate,
                numberOfFrames: buffer.length,
                numberOfChannels: buffer.numberOfChannels
            })
            zip.file(`${trackNames[stemIndex]}.wav`, file, {binary: true})
        }
        const {status, value: arrayBuffer, error} = await Promises.tryCatch(zip.generateAsync({
            type: "arraybuffer",
            compression: "DEFLATE",
            compressionOptions: {level: 6}
        }))
        dialog.terminate()
        if (status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Error",
                message: `Could not create zip file: ${String(error)}`
            })
            return
        }
        return saveFileAfterAsync({
            buffer: arrayBuffer,
            headline: "Save Zip",
            message: `Size: ${arrayBuffer.byteLength >> 20}M`,
            suggestedName: `${meta.name}.zip`
        })
    }

    const loadFFmepg = async (): Promise<FFmpegWorker> => {
        const {FFmpegWorker} = await Promises.guardedRetry(() =>
            import("@opendaw/studio-core/FFmpegWorker"), (_, count) => count < 60)
        const progress = new DefaultObservableValue(0.0)
        const progressDialog = RuntimeNotifier.progress({headline: "Loading FFmpeg...", progress})
        const {status, value, error} = await Promises.tryCatch(FFmpegWorker.load(value => progress.setValue(value)))
        progressDialog.terminate()
        if (status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Error",
                message: `Could not load FFmpeg: ${String(error)}`
            })
            throw error
        }
        return value
    }

    // browsers need a user-input to allow download
    const saveFileAfterAsync = async ({buffer, headline, message, suggestedName}: {
        buffer: ArrayBuffer,
        headline: string,
        message?: string,
        suggestedName: string
    }) => {
        const approved = await RuntimeNotifier.approve({headline, message: message ?? "", approveText: "Save"})
        if (!approved) {return}
        const saveResult = await Promises.tryCatch(Files.save(buffer, {suggestedName}))
        if (saveResult.status === "rejected" && !Errors.isAbort(saveResult.error)) {
            panic(String(saveResult.error))
        }
    }
}