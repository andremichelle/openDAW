import {isDefined} from "@opendaw/lib-std"
import {EngineVariant, EngineWorkletVariant} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Shell} from "@/platform/desktop/Shell"
import {NativeEnginePort} from "@/platform/desktop/bridge/NativeEnginePort"

// The engine runs in the native engine process. The webview node only holds a silent placeholder processor.
export namespace NativeEngine {
    const PlaceholderName = "opendaw-native-placeholder"
    const PlaceholderSource = `registerProcessor("${PlaceholderName}", class extends AudioWorkletProcessor {process() {return true}})`

    export const attach = async (service: StudioService): Promise<void> => {
        const {engine} = Shell.info()
        if (!isDefined(engine)) {return}
        const url = URL.createObjectURL(new Blob([PlaceholderSource], {type: "text/javascript"}))
        await service.audioContext.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)
        const wasm = EngineVariant.current()
        EngineVariant.install((): EngineWorkletVariant => ({
            processorName: PlaceholderName,
            attachment: {wasmUrl: "/wasm-engine"},
            connectSync: wasm.connectSync,
            port: (options, context) => new NativeEnginePort(
                `ws://127.0.0.1:${engine.port}/?token=${engine.token}`, context.sampleRate, options)
        }))
        console.debug(`[NativeEngine] engine process on port ${engine.port}`)
    }
}
