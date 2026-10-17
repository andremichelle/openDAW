import {isDefined, Nullable, RuntimeNotifier, TimeSpan} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {AudioInputs, EngineVariant, EngineWorkletVariant, OfflineEngineRenderer, WebAudioInputs} from "@opendaw/studio-core"
import {ScriptCompiler} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {OutputLatency} from "@/audio/OutputLatency"
import {NativeAudioInputs} from "@/platform/desktop/NativeAudioInputs"
import {Shell} from "@/platform/desktop/Shell"
import {NativeEnginePort} from "@/platform/desktop/bridge/NativeEnginePort"
import {NativeOfflineWorker} from "@/platform/desktop/bridge/NativeOfflineWorker"
import {NativePluginHost} from "@/platform/desktop/NativePluginHost"

// The engine runs in the native engine process. The webview node only holds a silent placeholder processor.
export namespace NativeEngine {
    const PlaceholderName = "opendaw-native-placeholder"
    const PlaceholderSource = `registerProcessor("${PlaceholderName}", class extends AudioWorkletProcessor {process() {return true}})`

    const reachable = (url: string): Promise<boolean> => new Promise(resolve => {
        const socket = new WebSocket(url)
        socket.onopen = () => {
            socket.close()
            resolve(true)
        }
        socket.onerror = () => resolve(false)
    })

    // the engine process may still be starting, it is given a few seconds before the webview engine is kept
    const connect = async (url: string): Promise<boolean> => {
        for (let attempt = 0; attempt < 20; attempt++) {
            if (await reachable(url)) {return true}
            await Wait.timeSpan(TimeSpan.millis(250))
        }
        return false
    }

    export const attach = async (service: StudioService): Promise<void> => {
        const {engine} = Shell.info()
        if (!isDefined(engine)) {return}
        const url = `ws://127.0.0.1:${engine.port}/?token=${engine.token}`
        if (!await connect(url)) {
            console.warn("[NativeEngine] the engine process is not reachable, the engine runs in the webview")
            AudioInputs.install(WebAudioInputs)
            await RuntimeNotifier.info({
                headline: "Audio Engine Unavailable",
                message: "The native audio engine did not start. openDAW uses the built-in engine instead, which has higher and less steady latency. Restarting the app may help."
            })
            return
        }
        NativePluginHost.attachService(service)
        // script code runs in the engine process, inside the engine's render like in the worklet; the latest code of
        // each script goes to every engine started later
        const scripts = new Map<string, string>()
        const current: { port: Nullable<NativeEnginePort> } = {port: null}
        ScriptCompiler.installLoader(async (uuid, code) => {
            scripts.set(uuid, code)
            current.port?.send({type: "script", code})
        })
        OfflineEngineRenderer.installWorkerFactory(workerUrl => new NativeOfflineWorker(
            `ws://127.0.0.1:${engine.port}/offline?token=${engine.token}&worker=${encodeURIComponent(workerUrl)}`))
        const placeholder = URL.createObjectURL(new Blob([PlaceholderSource], {type: "text/javascript"}))
        await service.audioContext.audioWorklet.addModule(placeholder)
        URL.revokeObjectURL(placeholder)
        const latency = {seconds: 0.0}
        OutputLatency.install(() => latency.seconds)
        NativeAudioInputs.outputLatency(() => latency.seconds)
        const wasm = EngineVariant.current()
        EngineVariant.install((): EngineWorkletVariant => ({
            processorName: PlaceholderName,
            attachment: {wasmUrl: "/wasm-engine"},
            connectSync: wasm.connectSync,
            port: (options, context, node) => {
                const port = new NativeEnginePort(url, context.sampleRate, options,
                    seconds => latency.seconds = seconds, info => NativeAudioInputs.updateInfo(info),
                    (uuid, peaks) => NativeAudioInputs.deliverPeaks(uuid, peaks),
                    devices => NativeAudioInputs.updateDevices(devices),
                    (uuid, first, planes) => NativeAudioInputs.deliverRecording(uuid, first, planes),
                    seconds => NativeAudioInputs.updateInputLatency(seconds),
                    message => {
                        const error = new Error(message)
                        node.dispatchEvent(new ErrorEvent("error", {error, message}))
                    }, Array.from(scripts.values()))
                current.port = port
                NativeAudioInputs.attachPort(port)
                NativePluginHost.attachPort(port)
                return port
            }
        }))
        console.debug(`[NativeEngine] engine process on port ${engine.port}`)
    }
}
