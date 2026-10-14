import {createElement} from "@opendaw/lib-jsx"
import {Bytes, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {AudioContentFactory, InstrumentTranscription, Project, TranscriptionSource} from "@opendaw/studio-core"
import {AudioRegionBoxAdapter, InstrumentFactories} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {ensureInference} from "./InferenceLoader"
import {Dialogs} from "@/ui/components/dialogs"
import {StudioService} from "./StudioService"

export class NeuralTranscription {
    /** File entry mirrors Neural Demux; clip menus reuse run() below. */
    static readonly browse = async (service: StudioService): Promise<void> => {
        let files: ReadonlyArray<File>
        try {
            files = await Files.open({types: [{description: "Audio", accept: {"audio/*": [".wav", ".mp3", ".flac", ".m4a", ".ogg"]}}]})
        } catch {return}
        const file = files[0]
        if (file === undefined) {return}
        await NeuralTranscription.importFile(service, file)
    }

    static readonly importFile = async (service: StudioService, file: File): Promise<void> => {
        try {
            await ensureInference()
            const {MuScriptor} = await import("@opendaw/lib-inference")
            await MuScriptor.checkSupport()
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
                await NeuralTranscription.run(project, source)
            } finally {importing.terminate()}
        } catch (error) {
            RuntimeNotifier.notify({message: error instanceof Error ? error.message : "Could not import audio.", icon: "Warning"})
        }
    }

    static readonly run = async (project: Project, source: TranscriptionSource): Promise<void> => {
        if (InstrumentTranscription.isRunning(project)) {return}
        try {
            await ensureInference()
            const {MuScriptor} = await import("@opendaw/lib-inference")
            await MuScriptor.checkSupport()
            try {
                await Dialogs.show({headline: "Convert Instruments to MIDI", okText: "Convert", cancelable: true,
                    content: <div style={{maxWidth: "380px"}}>
                        <p>Detects instruments in this audio and creates a separate MIDI track and clip for each instrument group.</p>
                        <p>MuScriptor Medium runs on your computer. Audio stays here. The model is a {Bytes.toString(MuScriptor.downloadBytes)} download, cached for later use.</p>
                        <p>Experimental transcription; notes and instrument labels may need editing. New tracks use Neon for audition; choose your own instruments afterward.</p>
                        <p>Model weights: <a href="https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx" target="_blank" rel="noopener noreferrer">CC BY-NC 4.0 (non-commercial)</a>.</p>
                    </div>})
            } catch {return}
            await InstrumentTranscription.convert(project, source, async (data, range, {signal, progress, message}) => {
                const notes = await MuScriptor.run({channels: data.frames, sampleRate: data.sampleRate, ...range}, {
                    signal, progress: ({phase, value}) => {
                        message(phase === "download" ? "Downloading model (cached for later use)"
                            : phase === "cache" ? "Reading cached model"
                            : phase === "load" ? "Loading MuScriptor on the GPU" : "Detecting notes and instruments")
                        progress(phase === "download" || phase === "cache" ? value * 0.4
                            : phase === "load" ? 0.4 + value * 0.05 : 0.45 + value * 0.55)
                    }
                })
                return notes.map(note => ({...note, start: note.start + range.start, end: note.end + range.start}))
            })
        } catch (error) {
            console.warn(error)
            RuntimeNotifier.notify({message: error instanceof Error ? error.message : "Could not start transcription.", icon: "Warning"})
        }
    }
}
