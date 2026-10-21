import {createElement} from "@opendaw/lib-jsx"
import {RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {AudioContentFactory, Project} from "@opendaw/studio-core"
import {InstrumentTranscription, TranscriptionSource} from "./InstrumentTranscription"
import type {MuScriptor} from "@opendaw/lib-inference/muscriptor"
import {AudioRegionBoxAdapter, InstrumentFactories} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {ensureInference} from "./InferenceLoader"
import {Dialogs} from "@/ui/components/dialogs"
import {StudioService} from "./StudioService"

export class MuScriptorTranscription {
    /** File entry mirrors Neural Demux; clip menus reuse run() below. */
    static readonly browse = async (service: StudioService): Promise<void> => {
        let files: ReadonlyArray<File>
        try {
            files = await Files.open({types: [{description: "Audio", accept: {"audio/*": [".wav", ".mp3", ".flac", ".m4a", ".ogg"]}}]})
        } catch {return}
        const file = files[0]
        if (file === undefined) {return}
        await MuScriptorTranscription.importFile(service, file)
    }

    static readonly importFile = async (service: StudioService, file: File): Promise<void> => {
        try {
            const prepared = await MuScriptorTranscription.#prepare()
            if (prepared === undefined) {return}
            if (!service.hasProfile) {await service.newProject()}
            if (!service.hasProfile || InstrumentTranscription.isRunning(service.project)) {return}
            const project = service.project
            const importing = RuntimeNotifier.progress({headline: "Importing audio", message: file.name})
            try {
                // A file import keeps original seconds; detected BPM is not needed for transcription.
                const sample = await service.sampleService.importFile({name: file.name, arrayBuffer: await file.arrayBuffer(), bpm: 0})
                await service.sampleManager.getAudioData(UUID.parse(sample.uuid))
                if (!service.hasProfile || service.project !== project) {return}
                const source = project.editing.modify(() => {
                    const {trackBox} = project.api.createInstrument(InstrumentFactories.Tape, {name: file.name})
                    const uuid = UUID.parse(sample.uuid)
                    const audioFileBox = project.boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() =>
                        AudioFileBox.create(project.boxGraph, uuid, box => {
                            box.fileName.setValue(file.name)
                            box.endInSeconds.setValue(sample.duration)
                        }))
                    return project.boxAdapters.adapterFor(AudioContentFactory.createNotStretchedRegion({
                        boxGraph: project.boxGraph, sample, audioFileBox, position: 0, targetTrack: trackBox
                    }), AudioRegionBoxAdapter)
                }).unwrap()
                importing.terminate()
                await MuScriptorTranscription.#convert(project, source, prepared)
            } finally {importing.terminate()}
        } catch (error) {
            RuntimeNotifier.notify({message: error instanceof Error ? error.message : "Could not import audio.", icon: "Warning"})
        }
    }

    static readonly run = async (project: Project, source: TranscriptionSource): Promise<void> => {
        if (InstrumentTranscription.isRunning(project)) {return}
        try {
            const prepared = await MuScriptorTranscription.#prepare()
            if (prepared === undefined) {return}
            await MuScriptorTranscription.#convert(project, source, prepared)
        } catch (error) {
            console.warn(error)
            RuntimeNotifier.notify({message: error instanceof Error ? error.message : "Could not start transcription.", icon: "Warning"})
        }
    }

    static readonly #prepare = async (): Promise<{model: typeof MuScriptor, allowDownload: boolean} | undefined> => {
        await ensureInference()
        const {MuScriptor: model} = await import("@opendaw/lib-inference/muscriptor")
        await model.checkSupport()
        const requiredBytes = await model.requiredDownloadBytes()
        if (requiredBytes > 0) {
            try {
                await Dialogs.show({headline: "Download audio-to-MIDI model?", okText: "Download & Continue",
                    cancelable: true, buttons: [{text: "Cancel", onClick: handler => handler.close()}],
                    content: <div style={{maxWidth: "380px"}}>
                        <p><strong>Download required: {(requiredBytes / 1_000_000).toFixed(1)} MB</strong></p>
                        <p>Continue to download MuScriptor Medium from Hugging Face? The full model is {(model.downloadBytes / 1_000_000).toFixed(1)} MB.
                            Files stay in this browser for later conversions.</p>
                        <p>Audio processing stays on your computer. Experimental notes and instrument labels may need editing.
                            New tracks use Neon for audition.</p>
                        <p>Model weights: <a href="https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx" target="_blank" rel="noopener noreferrer">CC BY-NC 4.0 (non-commercial)</a>.
                            Continue only if your use meets these terms.</p>
                    </div>})
            } catch {return undefined}
        }
        return {model, allowDownload: requiredBytes > 0}
    }

    static readonly #convert = async (project: Project, source: TranscriptionSource,
                                      {model, allowDownload}: {model: typeof MuScriptor, allowDownload: boolean}): Promise<void> => {
        const modelSizeMB = (model.downloadBytes / 1_000_000).toFixed(1)
        await InstrumentTranscription.convert(project, source, async (data, range, {signal, progress, message}) => {
            const notes = await model.run({channels: data.frames, sampleRate: data.sampleRate, ...range}, {
                signal, allowDownload, progress: ({phase, value}) => {
                    message(phase === "download" ? `Downloading model (${modelSizeMB} MB total)`
                        : phase === "cache" ? `Reading cached model (${modelSizeMB} MB)`
                        : phase === "load" ? "Loading MuScriptor on the GPU" : "Detecting notes and instruments")
                    progress(phase === "download" || phase === "cache" ? value * 0.4
                        : phase === "load" ? 0.4 + value * 0.05 : 0.45 + value * 0.55)
                }
            })
            return notes.map(note => ({...note, start: note.start + range.start, end: note.end + range.start}))
        })
    }
}
