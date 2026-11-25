import {Errors, isDefined, Optional, tryCatch} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {ENGINE_TABLE_RESERVE} from "./boot"

type UserAgentData = { getHighEntropyValues(hints: ReadonlyArray<string>): Promise<Record<string, unknown>> }
type ProbeOptions = { modules: ReadonlyArray<WebAssembly.Module>, instantiate: boolean, tableSize: number }

export namespace WorkletProbe {
    const PROCESSOR_NAME = "opendaw-worklet-probe"
    const TIMEOUT_MS = 1000
    // (func (export "f") (result i32) i32.const 42)
    const TINY_WASM = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03, 0x02, 0x01,
        0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b])
    const SOURCE = `
const stubImports = (module, tableSize) => {
    const imports = {}
    for (const {module: scope, name, kind} of WebAssembly.Module.imports(module)) {
        const target = imports[scope] ?? (imports[scope] = {})
        if (kind === "function") {target[name] = () => 0}
        else if (kind === "memory") {target[name] = new WebAssembly.Memory({initial: 256})}
        else if (kind === "table") {target[name] = new WebAssembly.Table({initial: tableSize, element: "anyfunc"})}
    }
    return imports
}
registerProcessor("${PROCESSOR_NAME}", class extends AudioWorkletProcessor {
    constructor(options) {
        super()
        const {modules = [], instantiate = false, tableSize = 0} = options?.processorOptions ?? {}
        const report = {received: modules.filter(module => module instanceof WebAssembly.Module).length + "/" + modules.length}
        try {
            if (instantiate) {modules.forEach(module => new WebAssembly.Instance(module, stubImports(module, tableSize)))}
            report.ok = true
        } catch (error) {
            report.error = String(error?.name) + ": " + String(error?.message)
        }
        this.port.postMessage(report)
    }
    process() {return false}
})`

    const stubImports = (module: WebAssembly.Module): WebAssembly.Imports => {
        const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {}
        WebAssembly.Module.imports(module).forEach(({module: scope, name, kind}) => {
            const target = imports[scope] ?? (imports[scope] = {})
            if (kind === "function") {target[name] = () => 0}
            if (kind === "memory") {target[name] = new WebAssembly.Memory({initial: 256})}
            if (kind === "table") {target[name] = new WebAssembly.Table({initial: ENGINE_TABLE_RESERVE, element: "anyfunc"})}
        })
        return imports
    }

    const runStage = (context: BaseAudioContext, options: Optional<ProbeOptions>): Promise<string> =>
        new Promise<string>(resolve => {
            const {status, value: node, error} = tryCatch(() => new AudioWorkletNode(context, PROCESSOR_NAME,
                {numberOfInputs: 0, numberOfOutputs: 1, processorOptions: options}))
            if (status === "failure") {
                resolve(`construct failed (${Errors.toString(error)})`)
                return
            }
            const finish = (result: string): void => {
                clearTimeout(timeout)
                node.port.close()
                resolve(result)
            }
            const timeout = setTimeout(() => finish("timeout"), TIMEOUT_MS)
            node.onprocessorerror = (event: Event) =>
                finish(`processorerror (${event instanceof ErrorEvent ? event.message : event.type})`)
            node.port.onmessage = (event: MessageEvent) => finish(JSON.stringify(event.data))
        })

    const describeDevice = async (): Promise<string> => {
        const userAgentData: Optional<UserAgentData> = Reflect.get(navigator, "userAgentData")
        const deviceMemory: Optional<number> = Reflect.get(navigator, "deviceMemory")
        const values = isDefined(userAgentData)
            ? await userAgentData.getHighEntropyValues(["architecture", "bitness", "platformVersion", "model", "fullVersionList"])
                .catch(reason => ({error: Errors.toString(reason)}))
            : {userAgentData: "n/a"}
        return JSON.stringify({...values, deviceMemory, cores: navigator.hardwareConcurrency, crossOriginIsolated})
    }

    // Runs after the engine processor failed to start and logs which step fails on this machine.
    export const run = async (context: BaseAudioContext, engineModule: WebAssembly.Module,
                              deviceModules: ReadonlyArray<WebAssembly.Module>): Promise<void> => {
        const log = (stage: string, result: string) => console.warn(`[WorkletProbe] ${stage}: ${result}`)
        log("device", await describeDevice())
        const url = URL.createObjectURL(new Blob([SOURCE], {type: "text/javascript"}))
        const added = await Promises.tryCatch(context.audioWorklet.addModule(url))
        URL.revokeObjectURL(url)
        if (added.status === "rejected") {
            log("addModule", `failed (${Errors.toString(added.error)})`)
            return
        }
        const tiny = new WebAssembly.Module(TINY_WASM)
        log("empty", await runStage(context, undefined))
        log("tiny received", await runStage(context, {modules: [tiny], instantiate: false, tableSize: 0}))
        log("tiny instantiated", await runStage(context, {modules: [tiny], instantiate: true, tableSize: 0}))
        log("engine received", await runStage(context, {modules: [engineModule], instantiate: false, tableSize: 0}))
        log("engine instantiated", await runStage(context,
            {modules: [engineModule], instantiate: true, tableSize: ENGINE_TABLE_RESERVE}))
        log("devices received", await runStage(context, {modules: deviceModules, instantiate: false, tableSize: 0}))
        const main = await Promises.tryCatch(WebAssembly.instantiate(engineModule, stubImports(engineModule)))
        log("engine instantiated on main thread", main.status === "resolved" ? "ok" : Errors.toString(main.error))
    }
}
