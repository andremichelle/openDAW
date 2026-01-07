import {DefaultObservableValue, Errors, Option, panic, RuntimeNotifier, TimeSpan} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {
    ExternalLib,
    FFmpegConverter,
    FFmpegWorker,
    OfflineEngineRenderer,
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
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            cancel: () => abortController.abort()
        })
        const progress = (seconds: number) => dialog.message = `Progress: ${TimeSpan.toHHMMSS(seconds)}`
        const result = await Promises.tryCatch(OfflineEngineRenderer
            .start(project, Option.None, progress, abortController.signal))
        dialog.terminate()
        if (result.status === "rejected") {
            if (!Errors.isAbort(result.error)) {
                throw result.error
            }
            return
        }
        const audioData: AudioData = result.value
        const {resolve, reject, promise} = Promise.withResolvers<void>()
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Encode Mixdown",
            content: "openDAW will download FFmpeg (30MB) once to encode your mixdown unless you choose 'Wav'.",
            excludeOk: true,
            buttons: [
                {
                    text: "Mp3", onClick: handler => {
                        handler.close()
                        saveMp3File(audioData, meta).then(resolve, reject)
                    }, primary: false
                }, {
                    text: "Flac", onClick: handler => {
                        handler.close()
                        saveFlacFile(audioData, meta).then(resolve, reject)
                    }, primary: false
                }, {
                    text: "Wav", onClick: handler => {
                        handler.close()
                        saveWavFile(audioData, meta).then(resolve, reject)
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
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            cancel: () => abortController.abort()
        })
        const progress = (seconds: number) => dialog.message = `Progress: ${TimeSpan.toHHMMSS(seconds)}`
        const {status, value, error: renderError} = await Promises.tryCatch(OfflineEngineRenderer
            .start(project, Option.wrap(config), progress, abortController.signal))
        dialog.terminate()
        if (status === "rejected") {
            if (Errors.isAbort(renderError)) {return}
            await RuntimeNotifier.info({headline: "Export Failed", message: String(renderError)})
            return
        }
        const {status: zipStatus, error: zipError} = await Promises.tryCatch(
            saveZipFile(value, meta, Object.values(config).map(({fileName}) => fileName)))
        if (zipStatus === "rejected") {
            await RuntimeNotifier.info({headline: "Export Failed", message: String(zipError)})
            return
        }
    }

    const saveWavFile = async (audioData: AudioData, meta: ProjectMeta) => {
        return saveFileAfterAsync({
            buffer: WavFile.encodeFloats(audioData),
            headline: "Save Wav",
            suggestedName: `${meta.name}.wav`
        })
    }

    const saveMp3File = async (audioData: AudioData, meta: ProjectMeta) => {
        const ffmpeg = await loadFFmepg()
        return encodeAndSaveFile({
            converter: ffmpeg.mp3Converter(),
            fileExtension: "mp3",
            fileType: "Mp3",
            fileName: meta.name,
            audioData
        })
    }

    const saveFlacFile = async (audioData: AudioData, meta: ProjectMeta) => {
        const ffmpeg = await loadFFmepg()
        return encodeAndSaveFile({
            converter: ffmpeg.flacConverter(),
            fileExtension: "flac",
            fileType: "Flac",
            fileName: meta.name,
            audioData
        })
    }

    const encodeAndSaveFile = async ({audioData, converter, fileType, fileExtension, fileName}: {
        audioData: AudioData,
        converter: FFmpegConverter<unknown>,
        fileType: string,
        fileExtension: string,
        fileName: string
    }) => {
        const progress = new DefaultObservableValue(0.0)
        const progressDialog = RuntimeNotifier.progress({headline: `Encoding ${fileType}...`, progress})
        const flac = await converter.convert(new Blob([WavFile.encodeFloats(audioData)]),
            value => progress.setValue(value))
        progressDialog.terminate()
        return saveFileAfterAsync({
            buffer: flac,
            headline: `Save ${fileType}`,
            suggestedName: `${fileName}.${fileExtension}`
        })
    }

    const saveZipFile = async (audioData: AudioData, meta: ProjectMeta, trackNames: ReadonlyArray<string>) => {
        const libResult = await ExternalLib.JSZip()
        if (libResult.status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Error",
                message: `Could not load JSZip: ${String(libResult.error)}`
            })
            return Promise.reject(libResult.error)
        }
        const dialog = RuntimeNotifier.progress({headline: "Creating Zip File..."})
        const numStems = audioData.numberOfChannels >> 1
        const zip = new libResult.value()
        for (let stemIndex = 0; stemIndex < numStems; stemIndex++) {
            const l = audioData.frames[stemIndex * 2]
            const r = audioData.frames[stemIndex * 2 + 1]
            const stemData = AudioData.create(audioData.sampleRate, audioData.numberOfFrames, 2)
            stemData.frames[0].set(l)
            stemData.frames[1].set(r)
            const file = WavFile.encodeFloats(stemData)
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