// ensureReady must register the engine processor on EVERY AudioContext it is given. It used to skip addModule
// once the wasm modules were compiled, so a second AudioContext (a host that rebuilds its context, e.g. after a
// hot reload) never got "engine-wasm-processor" and its first engine failed in the AudioWorkletNode constructor
// with "The node name 'engine-wasm-processor' is not defined in AudioWorkletGlobalScope".
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi} from "vitest"
import type {WasmEngine as WasmEngineNamespace} from "../src/WasmEngine"
import {DEVICES} from "../src/engine-modules"

// The smallest valid wasm module (magic number + version 1): loadEngineModules really compiles it.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const URLS = {
    processorUrl: "/wasm-engine/wasm-processor.js",
    offlineWorkerUrl: "/wasm-engine/wasm-offline-worker.js",
    wasmUrl: "/wasm-engine"
}
const MODULE_COUNT = DEVICES.length + 1
// studio-core touches AudioWorkletNode at module scope; node has none.
vi.stubGlobal("AudioWorkletNode", class {})

type FakeContext = { context: BaseAudioContext, addModule: Mock<AudioWorklet["addModule"]> }

const createContext = (addModule: Mock<AudioWorklet["addModule"]> =
                           vi.fn<AudioWorklet["addModule"]>(() => Promise.resolve())): FakeContext => {
    const audioWorklet: Pick<AudioWorklet, "addModule"> = {addModule}
    return {context: {audioWorklet} as BaseAudioContext, addModule}
}

// The namespace keeps its state at module scope, so each test imports a fresh copy.
const loadWasmEngine = async (): Promise<typeof WasmEngineNamespace> => {
    vi.resetModules()
    const {WasmEngine} = await import("../src/WasmEngine")
    return WasmEngine
}

let fetchWasm: Mock<(url: string) => Promise<Response>>
// The first import transforms studio-core, which can outlast a test's timeout; later imports only re-evaluate.
beforeAll(async () => {await import("../src/WasmEngine")}, 60_000)
beforeEach(() => {
    fetchWasm = vi.fn<(url: string) => Promise<Response>>(() => Promise.resolve(new Response(EMPTY_WASM)))
    vi.stubGlobal("fetch", fetchWasm)
    vi.spyOn(console, "debug").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
afterAll(() => vi.unstubAllGlobals())

describe("WasmEngine.ensureReady", () => {
    it("registers the engine processor on a second AudioContext", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        const first = createContext()
        const second = createContext()
        expect(await WasmEngine.ensureReady(first.context)).toBe(true)
        expect(await WasmEngine.ensureReady(second.context)).toBe(true)
        expect(first.addModule.mock.calls).toEqual([[URLS.processorUrl]])
        expect(second.addModule.mock.calls).toEqual([[URLS.processorUrl]])
    })

    it("a second AudioContext reuses the compiled modules", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        await WasmEngine.ensureReady(createContext().context)
        expect(fetchWasm).toHaveBeenCalledTimes(MODULE_COUNT)
        await WasmEngine.ensureReady(createContext().context)
        expect(fetchWasm).toHaveBeenCalledTimes(MODULE_COUNT)
    })

    it("a ready AudioContext is not registered again", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        const {context, addModule} = createContext()
        expect(await WasmEngine.ensureReady(context)).toBe(true)
        expect(await WasmEngine.ensureReady(context)).toBe(true)
        expect(addModule).toHaveBeenCalledTimes(1)
    })

    // Harmless on main (re-adding a url resolves from the worklet's module map), but it pins the per-context map.
    it("two concurrent calls on one AudioContext add the module once", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        const {context, addModule} = createContext()
        expect(await Promise.all([WasmEngine.ensureReady(context), WasmEngine.ensureReady(context)]))
            .toEqual([true, true])
        expect(addModule).toHaveBeenCalledTimes(1)
    })

    it("a failed registration is retried by the next call", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        const abort = new DOMException("Unable to load a worklet's module.", "AbortError")
        const {context, addModule} =
            createContext(vi.fn<AudioWorklet["addModule"]>().mockRejectedValueOnce(abort).mockResolvedValue())
        expect(await WasmEngine.ensureReady(context)).toBe(false)
        expect(await WasmEngine.ensureReady(context)).toBe(true)
        expect(addModule).toHaveBeenCalledTimes(2)
    })

    it("a failed compile is retried by the next call", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        fetchWasm.mockResolvedValueOnce(new Response(null, {status: 404, statusText: "Not Found"}))
        const {context} = createContext()
        expect(await WasmEngine.ensureReady(context)).toBe(false)
        expect(await WasmEngine.ensureReady(context)).toBe(true)
        expect(fetchWasm).toHaveBeenCalledTimes(MODULE_COUNT * 2)
    })

    // packages/app/studio/src/boot.ts reads the boolean to show its "Engine Unavailable" dialog.
    it("still resolves false and warns with the cause when addModule fails", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        const abort = new DOMException("Unable to load a worklet's module.", "AbortError")
        const {context} = createContext(vi.fn<AudioWorklet["addModule"]>().mockRejectedValue(abort))
        expect(await WasmEngine.ensureReady(context)).toBe(false)
        expect(console.warn).toHaveBeenCalledWith("WASM engine unavailable:", abort)
    })

    it("rejects when WasmEngine.install never ran", async () => {
        const WasmEngine = await loadWasmEngine()
        await expect(WasmEngine.ensureReady(createContext().context))
            .rejects.toThrow("WasmEngine.install must run before ensureReady")
    })
})

// prepare does what ensureReady does but rejects with the error that kept the engine from loading, so a host can
// log or report it. ensureReady only returned false and wrote the cause to console.warn.
describe("WasmEngine.prepare", () => {
    const failOne = (file: string, response: () => Response): void => {
        fetchWasm.mockImplementation(url => Promise.resolve(url.endsWith(file) ? response() : new Response(EMPTY_WASM)))
    }

    it("rejects with the DOMException addModule rejected with", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        const abort = new DOMException("Unable to load a worklet's module.", "AbortError")
        const {context} = createContext(vi.fn<AudioWorklet["addModule"]>().mockRejectedValue(abort))
        await expect(WasmEngine.prepare(context)).rejects.toBe(abort)
    })

    it("rejects with an error naming the wasm url and the 404 status", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        failOne("/device_tubular.wasm", () => new Response(null, {status: 404, statusText: "Not Found"}))
        await expect(WasmEngine.prepare(createContext().context))
            .rejects.toThrow("Could not load wasm module '/wasm-engine/wasm/plugins/device_tubular.wasm' (404 Not Found)")
    })

    it("rejects with the CompileError of a broken binary", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        failOne("/device_tubular.wasm", () => new Response(new Uint8Array([0x3c, 0x21, 0x64, 0x6f])))
        await expect(WasmEngine.prepare(createContext().context)).rejects.toBeInstanceOf(WebAssembly.CompileError)
    })

    it("resolves on a second AudioContext and registers the processor there", async () => {
        const WasmEngine = await loadWasmEngine()
        WasmEngine.install(URLS)
        const first = createContext()
        const second = createContext()
        await WasmEngine.prepare(first.context)
        await WasmEngine.prepare(second.context)
        expect(second.addModule.mock.calls).toEqual([[URLS.processorUrl]])
        expect(fetchWasm).toHaveBeenCalledTimes(MODULE_COUNT)
        expect(await WasmEngine.ensureReady(second.context)).toBe(true)
    })

    it("rejects when WasmEngine.install never ran", async () => {
        const WasmEngine = await loadWasmEngine()
        await expect(WasmEngine.prepare(createContext().context))
            .rejects.toThrow("WasmEngine.install must run before prepare")
    })
})
