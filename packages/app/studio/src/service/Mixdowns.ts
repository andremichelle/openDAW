import {assert, DefaultObservableValue, Errors, int, Option, RuntimeNotifier, Terminator} from "@opendaw/lib-std"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {
    ExternalLib,
    MixdownSection,
    OfflineEngineRenderer,
    Project,
    ProjectMeta,
    ProjectProfile
} from "@opendaw/studio-core"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {ExportConfiguration} from "@opendaw/studio-adapters"
import {Dialogs} from "@/ui/components/dialogs"
import {AudioFormatSelector} from "@/ui/components/AudioFormatSelector"
import {MixdownSectionSelector} from "@/ui/components/MixdownSectionSelector"
import {AudioFormats} from "@/audio/AudioFormats"

export namespace Mixdowns {
    const mixdownFormat = new DefaultObservableValue<AudioFormats.Format>(AudioFormats.All[0])
    const mixdownSectionKey = new DefaultObservableValue<string>("song")

    export const render = (project: Project,
                           optExportConfiguration: Option<ExportConfiguration>,
                           section: MixdownSection,
                           progress: DefaultObservableValue<number>,
                           abortSignal: AbortSignal,
                           sampleRate: int): Promise<AudioData> => section.type === "song"
        ? OfflineEngineRenderer.start(project, optExportConfiguration, progress, abortSignal, sampleRate)
        : OfflineEngineRenderer.renderSection(project, optExportConfiguration, section, progress, abortSignal, sampleRate)

    const fileName = (meta: ProjectMeta, section: MixdownSection): string =>
        section.type === "song" ? meta.name : `${meta.name} - ${section.label}`

    export const exportMixdown = async ({project: source, meta}: ProjectProfile): Promise<void> => {
        const formats = await AudioFormats.available()
        if (!formats.includes(mixdownFormat.getValue())) {mixdownFormat.setValue(formats[0])}
        const sections = MixdownSection.collect(source)
        const sectionModel = new DefaultObservableValue(MixdownSection.find(sections, mixdownSectionKey.getValue()))
        const lifecycle = new Terminator()
        const {status: dialogStatus, error: dialogError} = await Promises.tryCatch(Dialogs.show({
            headline: "Export Mixdown",
            content: [
                MixdownSectionSelector({lifecycle, sections, model: sectionModel}),
                AudioFormatSelector({lifecycle, formats, model: mixdownFormat})
            ],
            okText: "Export"
        }))
        lifecycle.terminate()
        if (dialogStatus === "rejected") {
            if (Errors.isAbort(dialogError)) {return}
            throw dialogError
        }
        const format = mixdownFormat.getValue()
        const section = sectionModel.getValue()
        mixdownSectionKey.setValue(section.key)
        const project = source.copy()
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const result = await Promises.tryCatch(
            render(project, Option.None, section, progress, abortController.signal, format.sampleRate))
        dialog.terminate()
        if (result.status === "rejected") {
            if (!Errors.isAbort(result.error)) {
                throw result.error
            }
            return
        }
        const buffer = await format.encode(result.value)
        return Files.saveWithApproval({
            buffer,
            headline: `Save ${format.label}`,
            suggestedName: `${fileName(meta, section)}.${format.extension}`
        })
    }

    export const exportStems = async ({project: source, meta}: ProjectProfile,
                                      config: ExportConfiguration,
                                      section: MixdownSection): Promise<void> => {
        const project = source.copy()
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const {status, value, error: renderError} = await Promises.tryCatch(
            render(project, Option.wrap(config), section, progress, abortController.signal, 48_000))
        dialog.terminate()
        if (status === "rejected") {
            if (Errors.isAbort(renderError)) {return}
            console.warn(renderError)
            RuntimeNotifier.notify({message: "Export failed.", icon: "Warning"})
            return
        }
        const {status: zipStatus, error: zipError} = await Promises.tryCatch(
            saveZipFile(value, fileName(meta, section), ExportConfiguration.stemFileNames(config)))
        if (zipStatus === "rejected") {
            console.warn(zipError)
            RuntimeNotifier.notify({message: "Export failed.", icon: "Warning"})
            return
        }
    }

    const saveZipFile = async (audioData: AudioData, zipName: string, trackNames: ReadonlyArray<string>) => {
        const libResult = await ExternalLib.JSZip()
        if (libResult.status === "rejected") {
            console.warn(libResult.error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(libResult.error)
        }
        const dialog = RuntimeNotifier.progress({headline: "Creating Zip File..."})
        const numStems = audioData.numberOfChannels >> 1
        // One name per rendered pair, or `trackNames[stemIndex]` quietly yields undefined and writes
        // "undefined.wav" instead of failing (which is exactly what a missing metronome name did).
        assert(trackNames.length === numStems,
            () => `Expected ${numStems} stem names for the rendered pairs, got ${trackNames.length}`)
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
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not create zip.", icon: "Warning"})
            return
        }
        return Files.saveWithApproval({
            buffer: arrayBuffer,
            headline: "Save Zip",
            message: `Size: ${arrayBuffer.byteLength >> 20}M`,
            suggestedName: `${zipName}.zip`
        })
    }
}