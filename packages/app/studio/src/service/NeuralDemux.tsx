import {createElement} from "@opendaw/lib-jsx"
import {
    Bytes,
    DefaultObservableValue,
    Errors,
    isAbsent,
    isDefined,
    Option,
    RuntimeNotifier,
    UUID
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {WavFile} from "@opendaw/lib-dsp"
import type {ExecutionProvider, Inference as InferenceNamespace, TaskKey} from "@opendaw/lib-inference"
import {AudioContentFactory, Project, ProjectMeta, ProjectProfile} from "@opendaw/studio-core"
import {InstrumentFactories, Sample} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"
import {ensureInference} from "@/service/InferenceLoader"

type StemSeparationKey = Extract<TaskKey, `stem-separation${string}`>

interface ModelOption {
    readonly key: StemSeparationKey
    readonly label: string
    readonly description: string
}

const MODELS: ReadonlyArray<ModelOption> = [
    {
        key: "stem-separation",
        label: "htdemucs v4 (smank, MIT)",
        description: "Hybrid Transformer Demucs v4 — drums / bass / other / vocals.\nONNX export: smank/htdemucs-onnx. License: MIT."
    },
    {
        key: "stem-separation-alt",
        label: "htdemucs v4 (jackjiangxinfa, Apache-2.0)",
        description: "Same Demucs v4 architecture, alternate ONNX export.\nUseful for A/B comparing separation quality. License: Apache-2.0."
    }
]

const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const
type StemName = typeof STEM_NAMES[number]

interface Selection {
    readonly model: ModelOption
    readonly provider: ExecutionProvider
}

const isWebGPUAvailable = (): boolean =>
    isDefined((navigator as Navigator & { gpu?: unknown }).gpu)

const providerLabel = (provider: ExecutionProvider): string =>
    provider === "webgpu" ? "WebGPU (GPU)" : "WASM (CPU)"

const lastProviderByTask = new Map<StemSeparationKey, ExecutionProvider>()

const decodeAudioFile = async (file: File, sampleRate: number):
    Promise<{ audio: Float32Array, channels: 1 | 2, frames: number }> => {
    const arrayBuffer = await file.arrayBuffer()
    const ctx = new AudioContext({sampleRate})
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    await ctx.close()
    const channels: 1 | 2 = decoded.numberOfChannels >= 2 ? 2 : 1
    const frames = decoded.length
    const planar = new Float32Array(channels * frames)
    for (let c = 0; c < channels; c++) {
        const sourceChannel = decoded.numberOfChannels >= 2 ? decoded.getChannelData(c) : decoded.getChannelData(0)
        planar.set(sourceChannel, c * frames)
    }
    return {audio: planar, channels, frames}
}

const pickSelection = async (Inference: typeof InferenceNamespace,
                             defaultKey: StemSeparationKey): Promise<Option<Selection>> => {
    const webgpu = isWebGPUAvailable()
    const defaultProvider: ExecutionProvider = webgpu ? "webgpu" : "wasm"
    const renderDescription = (model: ModelOption): string => {
        const size = Bytes.toString(Inference.modelDescriptor(model.key).bytes)
        return `${model.description}\n${size} one-time download.`
    }
    const modelSelect: HTMLSelectElement = (
        <select style={{font: "inherit", padding: "4px 8px", width: "100%"}}>
            {MODELS.map(model =>
                <option value={model.key} selected={model.key === defaultKey}>{model.label}</option>)}
        </select>
    ) as HTMLSelectElement
    const providerSelect: HTMLSelectElement = (
        <select style={{font: "inherit", padding: "4px 8px", width: "100%"}}>
            <option value="webgpu" disabled={!webgpu} selected={defaultProvider === "webgpu"}>
                {`WebGPU (GPU)${webgpu ? "" : " — not available in this browser"}`}
            </option>
            <option value="wasm" selected={defaultProvider === "wasm"}>WASM (CPU)</option>
        </select>
    ) as HTMLSelectElement
    const initial = MODELS.find(model => model.key === defaultKey)
    const descriptionEl: HTMLParagraphElement = (
        <p style={{margin: "8px 0 0", opacity: "0.7", fontSize: "12px", whiteSpace: "pre-line"}}>
            {isDefined(initial) ? renderDescription(initial) : ""}
        </p>
    ) as HTMLParagraphElement
    modelSelect.addEventListener("change", () => {
        const found = MODELS.find(model => model.key === modelSelect.value)
        descriptionEl.textContent = isDefined(found) ? renderDescription(found) : ""
    })
    const result = await Promises.tryCatch(Dialogs.show({
        headline: "Neural Demux",
        content: (
            <div style={{display: "flex", flexDirection: "column", gap: "8px", minWidth: "360px"}}>
                <label>Model</label>
                {modelSelect}
                <label style={{marginTop: "4px"}}>Execution provider</label>
                {providerSelect}
                {descriptionEl}
            </div>
        ),
        okText: "Separate",
        cancelable: true
    }))
    if (result.status === "rejected") {return Option.None}
    const found = MODELS.find(model => model.key === modelSelect.value)
    if (!isDefined(found)) {return Option.None}
    const provider: ExecutionProvider = providerSelect.value === "webgpu" ? "webgpu" : "wasm"
    return Option.wrap({model: found, provider})
}

export namespace NeuralDemux {
    export const explain = async (service: StudioService): Promise<void> => {
        const approved = await RuntimeNotifier.approve({
            headline: "Neural Demux",
            message: "Separates an audio file into drums, bass, vocals and other and turns it into an openDAW project.",
            approveText: "Browse...",
            cancelText: "Cancel"
        })
        if (!approved) {return}
        return run(service)
    }

    export const run = async (service: StudioService): Promise<void> => {
        const fileResult = await Promises.tryCatch(Files.open({
            types: [{
                description: "audio",
                accept: {"audio/*": [".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"]}
            }]
        }))
        if (fileResult.status === "rejected") {return}
        const fileMaybe = fileResult.value.at(0)
        if (isAbsent(fileMaybe)) {return}
        const file: File = fileMaybe
        const Inference = await ensureInference()
        const selectionOpt = await pickSelection(Inference, "stem-separation")
        if (selectionOpt.isEmpty()) {return}
        const {model, provider} = selectionOpt.unwrap()
        await service.audioContext.suspend()
        try {
            await runDemux()
        } finally {
            await service.audioContext.resume()
        }
        async function runDemux(): Promise<void> {
            if (!service.hasProfile) {
                service.projectProfileService.setValue(Option.wrap(
                    new ProjectProfile(UUID.generate(), Project.new(service), ProjectMeta.init("Untitled"), Option.None)))
            }
            const decoded = await Promises.tryCatch(decodeAudioFile(file, 44100))
            if (decoded.status === "rejected") {
                console.warn(decoded.error)
                RuntimeNotifier.notify({message: "Could not decode audio.", icon: "Warning"})
                return
            }
            const {audio, channels, frames} = decoded.value
            const previousProvider = lastProviderByTask.get(model.key)
            if (isDefined(previousProvider) && previousProvider !== provider) {
                await Inference.releaseTask(model.key)
            }
            const cached = await Inference.isCached(model.key)
            if (!cached) {
                const dlProgress = new DefaultObservableValue<number>(0)
                const dlController = new AbortController()
                const sizeLabel = Bytes.toString(Inference.modelDescriptor(model.key).bytes)
                const dlDialog = RuntimeNotifier.progress({
                    headline: "Downloading model",
                    message: `${sizeLabel}, one-time`,
                    progress: dlProgress,
                    cancel: () => dlController.abort(Errors.AbortError)
                })
                const preloadResult = await Promises.tryCatch(Inference.preload(model.key, {
                    progress: value => dlProgress.setValue(value),
                    signal: dlController.signal,
                    executionProvider: provider
                }))
                dlDialog.terminate()
                if (preloadResult.status === "rejected") {
                    if (!Errors.isAbort(preloadResult.error)) {
                        console.warn(preloadResult.error)
                        RuntimeNotifier.notify({message: "Model download failed.", icon: "Warning"})
                    }
                    return
                }
            } else {
                const loadController = new AbortController()
                const loadDialog = RuntimeNotifier.progress({
                    headline: "Loading model",
                    cancel: () => loadController.abort(Errors.AbortError)
                })
                const sessionResult = await Promises.tryCatch(Promise.race([
                    Inference.preload(model.key, {
                        signal: loadController.signal,
                        executionProvider: provider
                    }),
                    new Promise<never>((_, reject) => loadController.signal.addEventListener(
                        "abort", () => reject(Errors.AbortError), {once: true}))
                ]))
                loadDialog.terminate()
                if (sessionResult.status === "rejected") {
                    if (!Errors.isAbort(sessionResult.error)) {
                        console.warn(sessionResult.error)
                        RuntimeNotifier.notify({message: "Could not load model.", icon: "Warning"})
                    }
                    return
                }
            }
            const sepProgress = new DefaultObservableValue<number>(0)
            const sepController = new AbortController()
            const sepDialog = RuntimeNotifier.progress({
                headline: "Separating stems",
                message: `Using ${providerLabel(provider)}`,
                progress: sepProgress,
                cancel: () => sepController.abort(Errors.AbortError)
            })
            const inferenceResult = await Promises.tryCatch(Inference.run(model.key, {
                audio, channels, sampleRate: 44100
            }, {
                progress: value => sepProgress.setValue(value),
                signal: sepController.signal,
                downloadShare: 0,
                executionProvider: provider
            }))
            sepDialog.terminate()
            if (inferenceResult.status === "rejected") {
                if (!Errors.isAbort(inferenceResult.error)) {
                    console.warn(inferenceResult.error)
                    RuntimeNotifier.notify({message: "Neural demux failed.", icon: "Warning"})
                }
                return
            }
            lastProviderByTask.set(model.key, provider)
            const stems = inferenceResult.value
            const importDialog = RuntimeNotifier.progress({
                headline: "Neural Demux",
                message: "Importing stems..."
            })
            const project = service.project
            const sampleService = service.sampleService
            const importResults: Array<{ name: StemName, sample: Sample }> = []
            for (const stemName of STEM_NAMES) {
                const planar = stems[stemName].subarray(0, channels * frames)
                const arrayBuffer = WavFile.encodeInts16({
                    sampleRate: 44100,
                    length: frames,
                    numberOfChannels: channels,
                    getChannelData: (c: number) => planar.subarray(c * frames, (c + 1) * frames)
                })
                const importResult = await Promises.tryCatch(sampleService.importFile({
                    name: stemName,
                    arrayBuffer
                }))
                if (importResult.status === "rejected") {
                    console.warn(`Failed to import stem ${stemName}`, importResult.error)
                    continue
                }
                const sample = importResult.value
                await Promises.tryCatch(service.sampleManager.getAudioData(UUID.parse(sample.uuid)))
                importResults.push({name: stemName, sample})
            }
            importDialog.terminate()
            const {editing, boxGraph, api} = project
            editing.modify(() => {
                for (const {name, sample} of importResults) {
                    const {trackBox, instrumentBox} = api.createInstrument(InstrumentFactories.Tape)
                    instrumentBox.label.setValue(name)
                    const uuid = UUID.parse(sample.uuid)
                    const audioFileBox = boxGraph.findBox<AudioFileBox>(uuid)
                        .unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                            box.fileName.setValue(name)
                            box.startInSeconds.setValue(0)
                            box.endInSeconds.setValue(sample.duration)
                        }))
                    AudioContentFactory.createNotStretchedRegion({
                        boxGraph, sample, audioFileBox, position: 0, targetTrack: trackBox
                    })
                }
            })
        }
    }
}