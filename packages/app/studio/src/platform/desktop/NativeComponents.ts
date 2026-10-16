import {Bytes, DefaultObservableValue, Errors, isDefined, Option, RuntimeNotifier, TimeSpan} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {installFFmpegSource} from "@opendaw/studio-core/FFmpegWorker"
import type {Inference as InferenceApi, ModelDescriptor} from "@opendaw/lib-inference"
import {installInferenceHost} from "@/service/InferenceLoader"
import {installComponentHost} from "@/ui/manuals"
import {Shell} from "@/platform/desktop/Shell"

// Optional parts of the desktop app (FFmpeg, manuals, scripting docs, Neural Demux). The installer offers them on
// first launch; one that was left out is offered when it is first used, and offline the user is told why it is missing.
export namespace NativeComponents {
    type Status = {
        installed: boolean, selected: boolean, phase: "idle" | "downloading" | "done" | "error", done: number, total: number, message: string
    }
    type ManifestEntry = { path: string, size: number, download?: number, component?: string }
    type ComponentInfo = { name: string, label: string, description: string }
    type Model = { path: string, url: string, sha256: string, bytes: number }

    const Neural = "neural"

    const status = async (name: string): Promise<Status> => (await Shell.request("component-status", {name})).json()

    const manifest = async (): Promise<{ files: ReadonlyArray<ManifestEntry>, components: ReadonlyArray<ComponentInfo> }> => {
        const response = await fetch("/manifest.json")
        return response.ok ? response.json() : {files: [], components: []}
    }

    const modelPath = (taskKey: string, model: ModelDescriptor): string => `${taskKey}/${model.version}/model.onnx`

    const neuralModels = (inference: typeof InferenceApi): ReadonlyArray<Model> => inference.taskKeys().map(taskKey => {
        const model = inference.modelDescriptor(taskKey)
        return {path: modelPath(taskKey, model), url: model.url, sha256: model.sha256, bytes: model.bytes}
    })

    const download = async (name: string, label: string, total: number, models: ReadonlyArray<Model>): Promise<void> => {
        await Shell.request("component-install", {}, JSON.stringify({name, models}))
        const progress = new DefaultObservableValue<number>(0)
        const dialog = RuntimeNotifier.progress({headline: `Downloading ${label}`, message: Bytes.toString(total), progress})
        for (; ;) {
            await Wait.timeSpan(TimeSpan.millis(250))
            const current = await status(name)
            if (current.total > 0) {progress.setValue(current.done / current.total)}
            if (current.installed) {break}
            if (current.phase === "error") {
                dialog.terminate()
                await RuntimeNotifier.info({
                    headline: label,
                    message: `The download failed. ${label} needs an internet connection to be downloaded. (${current.message})`
                })
                return Promise.reject(Errors.AbortError)
            }
        }
        dialog.terminate()
    }

    // asks once, then downloads; resolves when the component is installed, rejects (AbortError) otherwise
    const ensure = async (name: string, inference?: typeof InferenceApi): Promise<void> => {
        if ((await status(name)).installed) {return}
        const {files, components} = await manifest()
        const info = components.find(component => component.name === name)
        const label = info?.label ?? name
        const models = isDefined(inference) ? neuralModels(inference) : []
        const total = files.filter(entry => entry.component === name).reduce((sum, entry) => sum + (entry.download ?? entry.size), 0)
            + models.reduce((sum, model) => sum + model.bytes, 0)
        const approved = await RuntimeNotifier.approve({
            headline: label,
            message: `${label} (${info?.description ?? ""}) is not installed yet. Download it now (${Bytes.toString(total)})? It works offline afterwards.`,
            approveText: "Download"
        })
        if (!approved) {return Promise.reject(Errors.AbortError)}
        return download(name, label, total, models)
    }

    // links into an optional part (manuals, scripting docs) install it before they open
    const interceptLinks = (): void => document.addEventListener("click", event => {
        const anchor = event.target instanceof Element ? event.target.closest("a") : null
        if (!isDefined(anchor)) {return}
        const {pathname} = new URL(anchor.href, location.href)
        const name = pathname.startsWith("/manuals/") ? "manuals" : pathname.startsWith("/docs/") ? "docs" : null
        if (!isDefined(name)) {return}
        event.preventDefault()
        const target = anchor.target.length > 0 ? anchor.target : "_blank"
        ensure(name).then(() => {window.open(anchor.href, target)}, () => {})
    }, true)

    export const attach = (): void => {
        if (!isDefined(Shell.info().engine)) {return}
        installComponentHost({ensure: name => ensure(name)})
        installFFmpegSource({baseURL: "/ffmpeg", prepare: () => ensure("ffmpeg")})
        installInferenceHost({
            ensureAvailable: inference => ensure(Neural, inference),
            modelSource: async (taskKey, model) => {
                const response = await Shell.request("component-model", {name: Neural, path: modelPath(taskKey, model)}).catch(() => null)
                return isDefined(response) && response.status === 200 ? Option.wrap(new Uint8Array(await response.arrayBuffer())) : Option.None
            },
            modelHosted: async () => (await status(Neural)).installed
        })
        interceptLinks()
    }
}
