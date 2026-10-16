import {isDefined, RuntimeNotifier, TimeSpan} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {CaptureAudioBackend, EngineVariant, EngineWorkletVariant} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {OutputLatency} from "@/audio/OutputLatency"
import {NativeCapture} from "@/platform/desktop/NativeCapture"
import {Shell} from "@/platform/desktop/Shell"
import {NativeEnginePort} from "@/platform/desktop/bridge/NativeEnginePort"

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
            await RuntimeNotifier.info({
                headline: "Audio Engine Unavailable",
                message: "The native audio engine did not start. openDAW uses the built-in engine instead, which has higher and less steady latency. Restarting the app may help."
            })
            return
        }
        const placeholder = URL.createObjectURL(new Blob([PlaceholderSource], {type: "text/javascript"}))
        await service.audioContext.audioWorklet.addModule(placeholder)
        URL.revokeObjectURL(placeholder)
        const latency = {seconds: 0.0}
        OutputLatency.install(() => latency.seconds)
        NativeCapture.outputLatency(() => latency.seconds)
        const wasm = EngineVariant.current()
        EngineVariant.install((): EngineWorkletVariant => ({
            processorName: PlaceholderName,
            attachment: {wasmUrl: "/wasm-engine"},
            connectSync: wasm.connectSync,
            port: (options, context) => {
                const port = new NativeEnginePort(url, context.sampleRate, options,
                    seconds => latency.seconds = seconds, info => NativeCapture.updateInfo(info),
                    (uuid, peaks) => NativeCapture.deliverPeaks(uuid, peaks),
                    devices => NativeCapture.updateDevices(devices),
                    (uuid, first, planes) => NativeCapture.deliverRecording(uuid, first, planes),
                    seconds => NativeCapture.updateInputLatency(seconds))
                NativeCapture.attachPort(port)
                return port
            }
        }))
        CaptureAudioBackend.install(NativeCapture.backend)
        console.debug(`[NativeEngine] engine process on port ${engine.port}`)
    }
}
