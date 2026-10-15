import {ModelStore} from "./ModelStore"
import {MUSCRIPTOR_ASSETS} from "./muscriptor/Model"
import {MuScriptorInput, MuScriptorNote, MuScriptorProgress, MuScriptorWorkerRequest, MuScriptorWorkerResponse} from "./muscriptor/types"

export class MuScriptor {
    static readonly downloadBytes = Object.values(MUSCRIPTOR_ASSETS).reduce((sum, asset) => sum + asset.bytes, 0)

    static readonly checkSupport = async (): Promise<void> => {
        const gpu = (navigator as Navigator & {gpu?: {requestAdapter(): Promise<{features: Set<string>} | null>}}).gpu
        const adapter = await gpu?.requestAdapter()
        if (!adapter?.features.has("shader-f16")) {
            throw new Error("MuScriptor needs a browser with WebGPU and FP16 support. Try a current hardware-accelerated Chromium browser.")
        }
    }

    static readonly run = async (input: MuScriptorInput, options: {
        signal: AbortSignal, progress: (value: MuScriptorProgress) => void, workerFactory?: () => Worker
    }): Promise<ReadonlyArray<MuScriptorNote>> => {
        const {signal, progress} = options
        signal.throwIfAborted()
        await MuScriptor.checkSupport()
        signal.throwIfAborted()
        const assets: Record<string, Uint8Array> = {}
        let loaded = 0
        for (const [name, descriptor] of Object.entries(MUSCRIPTOR_ASSETS)) {
            signal.throwIfAborted()
            const cached = await ModelStore.isCached(`muscriptor/${name}`, descriptor)
            assets[name] = await ModelStore.ensure(`muscriptor/${name}`, descriptor, {
                signal, progress: value => progress({phase: cached ? "cache" : "download",
                    value: (loaded + value * descriptor.bytes) / MuScriptor.downloadBytes})
            })
            loaded += descriptor.bytes
        }
        signal.throwIfAborted()
        const worker = options.workerFactory?.() ?? new Worker(new URL("./muscriptor/muscriptor.worker.js", import.meta.url),
            {type: "module", name: "opendaw-muscriptor"})
        return new Promise<ReadonlyArray<MuScriptorNote>>((resolve, reject) => {
            const cleanup = (): void => {signal.removeEventListener("abort", abort); worker.terminate()}
            const abort = (): void => {cleanup(); reject(signal.reason ?? new DOMException("Cancelled", "AbortError"))}
            signal.addEventListener("abort", abort, {once: true})
            worker.addEventListener("error", event => {cleanup(); reject(new Error(event.message))})
            worker.addEventListener("messageerror", () => {cleanup(); reject(new Error("MuScriptor worker communication failed"))})
            worker.addEventListener("message", (event: MessageEvent<MuScriptorWorkerResponse>) => {
                const message = event.data
                if (message.kind === "progress") {progress(message.value)}
                else if (message.kind === "result") {cleanup(); resolve(message.notes)}
                else {cleanup(); reject(new Error(message.message))}
            })
            if (signal.aborted) {abort(); return}
            const request: MuScriptorWorkerRequest = {input, assets}
            try {
                worker.postMessage(request, Object.values(assets).map(bytes => bytes.buffer as ArrayBuffer))
            } catch (error) {cleanup(); reject(error)}
        })
    }
}
