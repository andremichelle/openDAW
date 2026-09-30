// The WCLAP BRIDGE: the JS side of the Wclap device. The CLAP plugin (a wasm32 module with its own memory)
// runs as its OWN instance next to the engine, like the NAM bridge. The Rust side-module owns the openDAW side
// (ports, fields) and calls the `host_wclap_*` env imports defined here. Per chunk ≤128 samples per channel are
// copied between the two memories. Everything CLAP calls "main-thread" runs here between render quanta.
import {isDefined, isNotNull, isNull, Nullable, Optional, tryCatch, UUID} from "@opendaw/lib-std"
import {WclapBundle, WclapGuiInfo, WclapPluginInfo} from "@opendaw/studio-adapters"
import {decodeUtf8, encodeUtf8} from "../utf8"
import {ClapAbi} from "./clap-abi"
import {trampoline} from "./trampoline"
import {createWasiImports, readMemoryImportLimits} from "./wasi-shim"
import {decodeBase64} from "./base64"

export type WclapBundleLoader = (url: string) => Promise<WclapBundle>
export type WclapGuiSender = (uuid: string, bytes: ArrayBuffer) => void
export type WclapStateSender = (uuid: string, bytes: ArrayBuffer) => void

const RENDER_QUANTUM = 128
const URI_CAPACITY = 2048
const MIN_INITIAL_PAGES = 256
const SAVE_DELAY_CHUNKS = 40 // ~100 ms of quiet after the last change before the state is saved

type Loaded = {
    memory: WebAssembly.Memory
    table: WebAssembly.Table
    malloc: (size: number) => number
    plugin: number
    webview: number
    gui: number
    guiCreated: boolean
    processPtr: number
    inputs: [number, number]
    outputs: [number, number]
    inputPorts: number
    scratchPtr: number
    scratchSize: number
    steadyTime: bigint
    eventsPtr: number
    eventCount: number
    pendingNotes: Array<PendingNote>
    state: number
    params: number
    inEvents: number
    outEvents: number
    istream: number
    ostream: number
    readSource: Nullable<{ bytes: Uint8Array, cursor: number }>
    writeChunks: Array<Uint8Array>
}

type PendingNote = { on: boolean, key: number, velocity: number }
type Booted = { memory: WebAssembly.Memory, table: WebAssembly.Table, malloc: (size: number) => number, entry: number }

const EMPTY_LOADED: Omit<Loaded, "memory" | "table" | "malloc"> = {
    plugin: 0, webview: 0, gui: 0, guiCreated: false, processPtr: 0, inputs: [0, 0], outputs: [0, 0], inputPorts: 0,
    scratchPtr: 0, scratchSize: 0, steadyTime: 0n, eventsPtr: 0, eventCount: 0, pendingNotes: [], state: 0, params: 0,
    inEvents: 0, outEvents: 0, istream: 0, ostream: 0, readSource: null, writeChunks: []
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index])
const MAX_EVENTS = 64
const NOTE_EVENT_SIZE = 40

class Plugin {
    readonly uuid: string
    url: string = ""
    clapId: string = ""
    loaded: Nullable<Loaded> = null
    loading: boolean = false
    guiOpen: boolean = false
    generation: number = 0
    pendingState: Nullable<Uint8Array> = null
    knownState: Nullable<Uint8Array> = null
    dirtyCountdown: number = -1
    receivedSinceProcess: boolean = false

    constructor(uuid: string) {this.uuid = uuid}
}

export class WclapBridges {
    readonly #memory: WebAssembly.Memory
    readonly #loadBundle: WclapBundleLoader
    readonly #sendGui: WclapGuiSender
    readonly #sendState: WclapStateSender
    readonly #sampleRate: number
    readonly #plugins = new Map<number, Plugin>()
    readonly #byUuid = new Map<string, number>()
    readonly #modules = new Map<string, Promise<{ module: WebAssembly.Module, bundle: WclapBundle }>>()
    #nextHandle: number = 1
    #inProcess: boolean = false

    constructor(memory: WebAssembly.Memory, loadBundle: WclapBundleLoader, sendGui: WclapGuiSender,
                sendState: WclapStateSender, sampleRate: number) {
        this.#memory = memory
        this.#loadBundle = loadBundle
        this.#sendGui = sendGui
        this.#sendState = sendState
        this.#sampleRate = sampleRate
    }

    imports(): Record<string, (...args: Array<number>) => number | void> {
        return {
            host_wclap_create: (uuidPtr) => this.#create(uuidPtr),
            host_wclap_load: (handle, urlPtr, urlLen, idPtr, idLen) => this.#load(handle, urlPtr, urlLen, idPtr, idLen),
            host_wclap_process: (handle, in0, in1, out0, out1, frames) => this.#process(handle, in0, in1, out0, out1, frames),
            host_wclap_note: (handle, on, key, velocity) => this.#note(handle, on !== 0, key, velocity),
            host_wclap_state: (handle, ptr, len) => this.#state(handle, ptr, len),
            host_wclap_reset: (handle) => this.#reset(handle),
            host_wclap_release: (handle) => this.#release(handle)
        }
    }

    // Main-thread webview traffic, both between render quanta.
    receive(uuid: string, bytes: ArrayBuffer): void {
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin) || isNull(plugin.loaded) || plugin.loaded.webview === 0) {return}
        const loaded = plugin.loaded
        const source = new Uint8Array(bytes)
        if (loaded.scratchSize < source.length) {
            loaded.scratchPtr = loaded.malloc(source.length)
            loaded.scratchSize = source.length
        }
        new Uint8Array(loaded.memory.buffer).set(source, loaded.scratchPtr)
        this.#call(loaded, loaded.webview + ClapAbi.Webview.RECEIVE, loaded.plugin, loaded.scratchPtr, source.length)
        plugin.dirtyCountdown = SAVE_DELAY_CHUNKS
        plugin.receivedSinceProcess = true
    }

    // The webview's start page and the size the plugin asks for (clap.gui lifecycle: create, get_size,
    // set_parent, show). An empty uri means not loaded or no webview.
    openGui(uuid: string): WclapGuiInfo {
        const none: WclapGuiInfo = {uri: "", width: 0, height: 0}
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin) || isNull(plugin.loaded) || plugin.loaded.webview === 0) {return none}
        const loaded = plugin.loaded
        const uriPtr = loaded.malloc(URI_CAPACITY)
        const length = this.#call(loaded, loaded.webview + ClapAbi.Webview.GET_URI, loaded.plugin, uriPtr, URI_CAPACITY)
        if (length <= 0) {return none}
        const uri = this.#cstr(loaded.memory, uriPtr)
        const size = {width: 0, height: 0}
        if (loaded.gui !== 0 && !loaded.guiCreated) {
            const api = this.#alloc(loaded, ClapAbi.Gui.WINDOW_API_WEBVIEW)
            if (this.#call(loaded, loaded.gui + ClapAbi.Gui.CREATE, loaded.plugin, api, 0) !== 0) {
                loaded.guiCreated = true
                const sizePtr = loaded.malloc(8)
                if (this.#call(loaded, loaded.gui + ClapAbi.Gui.GET_SIZE, loaded.plugin, sizePtr, sizePtr + 4) !== 0) {
                    size.width = this.#u32(loaded.memory, sizePtr)
                    size.height = this.#u32(loaded.memory, sizePtr + 4)
                }
                const window = loaded.malloc(ClapAbi.Window.SIZE)
                new DataView(loaded.memory.buffer).setUint32(window + ClapAbi.Window.API, api, true)
                new DataView(loaded.memory.buffer).setUint32(window + ClapAbi.Window.PTR, 0, true)
                this.#call(loaded, loaded.gui + ClapAbi.Gui.SET_PARENT, loaded.plugin, window)
                this.#call(loaded, loaded.gui + ClapAbi.Gui.SHOW, loaded.plugin)
            }
        }
        plugin.guiOpen = true
        return {uri, ...size}
    }

    // Save now (the main thread debounces GUI traffic and asks on window close), a changed blob is pushed.
    // A plugin applies its page's messages only in `process` or `params.flush`, so flush first when the engine
    // has not rendered the device since the last message (stopped transport).
    saveState(uuid: string): void {
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return}
        if (plugin.receivedSinceProcess) {this.#flush(plugin, plugin.loaded)}
        this.#saveState(plugin, plugin.loaded)
    }

    #flush(plugin: Plugin, loaded: Loaded): void {
        plugin.receivedSinceProcess = false
        if (loaded.params === 0) {return}
        loaded.eventCount = 0
        this.#onAudioThread(() => this.#call(loaded, loaded.params + ClapAbi.Params.FLUSH, loaded.plugin, loaded.inEvents, loaded.outEvents))
    }

    closeGui(uuid: string): void {
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin)) {return}
        plugin.guiOpen = false
        const loaded = plugin.loaded
        if (isNull(loaded) || !loaded.guiCreated) {return}
        this.#call(loaded, loaded.gui + ClapAbi.Gui.HIDE, loaded.plugin)
        this.#call(loaded, loaded.gui + ClapAbi.Gui.DESTROY, loaded.plugin)
        loaded.guiCreated = false
    }

    #pluginByUuid(uuid: string): Optional<Plugin> {
        const handle = this.#byUuid.get(uuid)
        return isDefined(handle) ? this.#plugins.get(handle) : undefined
    }

    #create(uuidPtr: number): number {
        const uuid = UUID.toString(new Uint8Array(this.#memory.buffer, uuidPtr, 16).slice() as UUID.Bytes)
        const existing = this.#byUuid.get(uuid)
        if (isDefined(existing)) {return existing}
        const handle = this.#nextHandle++
        this.#plugins.set(handle, new Plugin(uuid))
        this.#byUuid.set(uuid, handle)
        return handle
    }

    #load(handle: number, urlPtr: number, urlLen: number, idPtr: number, idLen: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin)) {return}
        const url = decodeUtf8(new Uint8Array(this.#memory.buffer, urlPtr, urlLen).slice())
        const clapId = decodeUtf8(new Uint8Array(this.#memory.buffer, idPtr, idLen).slice())
        if (plugin.url === url && plugin.clapId === clapId) {return}
        plugin.url = url
        plugin.clapId = clapId
        this.#destroy(plugin)
        if (url.length === 0 || clapId.length === 0) {return}
        const generation = ++plugin.generation
        plugin.loading = true
        this.#module(url)
            .then(({module}) => this.#instantiate(plugin, module))
            .then(loaded => {
                if (plugin.generation !== generation) {return}
                plugin.loaded = loaded
                plugin.loading = false
                console.debug(`[wclap] ${clapId} ready`)
            })
            .catch(error => {
                plugin.loading = false
                console.error(`[wclap] failed to load ${clapId} from ${url}`, error)
            })
    }

    // The box's saved state blob (base64 out of the engine memory): applied now or once the plugin is up,
    // skipped when it is the blob this bridge saved itself (the box write comes back as a field delivery).
    #state(handle: number, ptr: number, len: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin)) {return}
        const bytes = decodeBase64(decodeUtf8(new Uint8Array(this.#memory.buffer, ptr, len).slice()))
        if (bytes.length === 0 || (isNotNull(plugin.knownState) && bytesEqual(plugin.knownState, bytes))) {return}
        plugin.pendingState = bytes
        console.debug(`[wclap] state delivered for ${plugin.clapId}: ${bytes.length} bytes, loaded=${isNotNull(plugin.loaded)}`)
        if (isNotNull(plugin.loaded)) {this.#loadState(plugin, plugin.loaded)}
    }

    #loadState(plugin: Plugin, loaded: Loaded): void {
        const bytes = plugin.pendingState
        plugin.pendingState = null
        if (isNull(bytes) || loaded.state === 0) {return}
        loaded.readSource = {bytes, cursor: 0}
        const ok = this.#call(loaded, loaded.state + ClapAbi.State.LOAD, loaded.plugin, loaded.istream)
        loaded.readSource = null
        plugin.knownState = bytes
        console.debug(`[wclap] state loaded into ${plugin.clapId}: ${bytes.length} bytes ok=${ok}`)
        if (ok === 0) {console.warn(`[wclap] ${plugin.clapId} rejected its saved state`)}
    }

    #saveState(plugin: Plugin, loaded: Loaded): void {
        if (loaded.state === 0) {return}
        loaded.writeChunks = []
        const ok = this.#call(loaded, loaded.state + ClapAbi.State.SAVE, loaded.plugin, loaded.ostream)
        const length = loaded.writeChunks.reduce((sum, chunk) => sum + chunk.length, 0)
        if (ok === 0 || length === 0) {return}
        const bytes = new Uint8Array(length)
        loaded.writeChunks.reduce((offset, chunk) => {
            bytes.set(chunk, offset)
            return offset + chunk.length
        }, 0)
        loaded.writeChunks = []
        if (isNotNull(plugin.knownState) && bytesEqual(plugin.knownState, bytes)) {return}
        plugin.knownState = bytes
        console.debug(`[wclap] state saved from ${plugin.clapId}: ${bytes.length} bytes`)
        this.#sendState(plugin.uuid, bytes.buffer)
    }

    #module(url: string): Promise<{ module: WebAssembly.Module, bundle: WclapBundle }> {
        const cached = this.#modules.get(url)
        if (isDefined(cached)) {return cached}
        const promise = this.#loadBundle(url).then(async bundle => {
            const file = bundle.files.find(({path}) => path === "module.wasm")
            if (!isDefined(file)) {throw new Error(`no module.wasm in ${url}`)}
            const module = await WebAssembly.compile(file.bytes)
            return {module, bundle}
        })
        this.#modules.set(url, promise)
        return promise
    }

    // The plugins a bundle's factory offers: a throwaway instance, entry init, descriptor walk, entry deinit.
    async describe(url: string): Promise<ReadonlyArray<WclapPluginInfo>> {
        const {module, bundle} = await this.#module(url)
        const {memory, table, malloc, entry} = await this.#boot(module, bundle, "describe")
        const loaded: Loaded = {...EMPTY_LOADED, memory, table, malloc}
        if (this.#call(loaded, entry + ClapAbi.PluginEntry.INIT, this.#alloc(loaded, "/describe")) === 0) {return []}
        const factory = this.#call(loaded, entry + ClapAbi.PluginEntry.GET_FACTORY, this.#alloc(loaded, ClapAbi.PluginFactory.ID))
        const count = factory === 0 ? 0 : this.#call(loaded, factory + ClapAbi.PluginFactory.GET_PLUGIN_COUNT, factory)
        const plugins = Array.from({length: count}, (_, index) => {
            const descriptor = this.#call(loaded, factory + ClapAbi.PluginFactory.GET_PLUGIN_DESCRIPTOR, factory, index)
            const features: Array<string> = []
            for (let ptr = this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.FEATURES); ptr !== 0 && this.#u32(memory, ptr) !== 0; ptr += 4) {
                features.push(this.#cstr(memory, this.#u32(memory, ptr)))
            }
            return {
                clapId: this.#cstr(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.ID)),
                name: this.#cstr(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.NAME)),
                vendor: this.#cstr(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.VENDOR)),
                features
            }
        })
        this.#call(loaded, entry + ClapAbi.PluginEntry.DEINIT)
        return plugins
    }

    // A fresh instance of the module with its own memory (declared limits, `memory.json`) and WASI shim.
    async #boot(module: WebAssembly.Module, bundle: WclapBundle, label: string): Promise<Booted> {
        const moduleBytes = bundle.files.find(({path}) => path === "module.wasm")?.bytes ?? new Uint8Array(0)
        const limits = readMemoryImportLimits(moduleBytes)
        const recommendedPages = this.#recommendedInitialPages(bundle)
        const imported = isDefined(limits)
            ? new WebAssembly.Memory({
                initial: Math.min(limits.maximum, Math.max(limits.initial, MIN_INITIAL_PAGES, recommendedPages)),
                maximum: limits.maximum, shared: limits.shared
            })
            : undefined
        const memoryRef: { memory: Nullable<WebAssembly.Memory> } = {memory: imported ?? null}
        const wasi = createWasiImports(module, () => memoryRef.memory ?? new WebAssembly.Memory({initial: 1}), label)
        const imports: WebAssembly.Imports = {...wasi, env: isDefined(imported) ? {memory: imported} : {}}
        const instance = await WebAssembly.instantiate(module, imports)
        const exports = instance.exports
        const memory = (exports.memory ?? imported) as WebAssembly.Memory
        memoryRef.memory = memory
        const table = exports.__indirect_function_table as WebAssembly.Table
        const malloc = exports.malloc as (size: number) => number
        const initialize = exports._initialize as Optional<() => void>
        if (isDefined(initialize)) {initialize()}
        const entry = (exports.clap_entry as WebAssembly.Global).value as number
        return {memory, table, malloc, entry}
    }

    async #instantiate(plugin: Plugin, module: WebAssembly.Module): Promise<Loaded> {
        const bundle = (await this.#module(plugin.url)).bundle
        const {memory, table, malloc, entry} = await this.#boot(module, bundle, plugin.clapId)
        const loaded: Loaded = {
            memory, table, malloc, plugin: 0, webview: 0, gui: 0, guiCreated: false, processPtr: 0,
            inputs: [0, 0], outputs: [0, 0], inputPorts: 0, scratchPtr: 0, scratchSize: 0, steadyTime: 0n,
            eventsPtr: 0, eventCount: 0, pendingNotes: [], state: 0, params: 0, inEvents: 0, outEvents: 0,
            istream: 0, ostream: 0, readSource: null, writeChunks: []
        }
        const host = this.#createHost(plugin, loaded)
        if (this.#call(loaded, entry + ClapAbi.PluginEntry.INIT, this.#alloc(loaded, `/${plugin.clapId}`)) === 0) {
            throw new Error("clap_entry.init failed")
        }
        const factory = this.#call(loaded, entry + ClapAbi.PluginEntry.GET_FACTORY, this.#alloc(loaded, ClapAbi.PluginFactory.ID))
        if (factory === 0) {throw new Error("no clap.plugin-factory")}
        const count = this.#call(loaded, factory + ClapAbi.PluginFactory.GET_PLUGIN_COUNT, factory)
        const idPtr = this.#alloc(loaded, plugin.clapId)
        const found = Array.from({length: count}, (_, index) => index).some(index => {
            const descriptor = this.#call(loaded, factory + ClapAbi.PluginFactory.GET_PLUGIN_DESCRIPTOR, factory, index)
            return this.#cstr(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.ID)) === plugin.clapId
        })
        if (!found) {throw new Error(`plugin id ${plugin.clapId} not in bundle`)}
        loaded.plugin = this.#call(loaded, factory + ClapAbi.PluginFactory.CREATE_PLUGIN, factory, host, idPtr)
        if (loaded.plugin === 0) {throw new Error("create_plugin returned null")}
        if (this.#call(loaded, loaded.plugin + ClapAbi.Plugin.INIT, loaded.plugin) === 0) {
            throw new Error("plugin.init failed")
        }
        loaded.webview = this.#extension(loaded, ClapAbi.Ext.WEBVIEW)
        loaded.gui = this.#extension(loaded, ClapAbi.Ext.GUI)
        loaded.state = this.#extension(loaded, ClapAbi.Ext.STATE)
        loaded.params = this.#extension(loaded, ClapAbi.Ext.PARAMS)
        this.#loadState(plugin, loaded)
        const audioPorts = this.#extension(loaded, ClapAbi.Ext.AUDIO_PORTS)
        loaded.inputPorts = audioPorts === 0 ? 1 : this.#call(loaded, audioPorts + ClapAbi.AudioPorts.COUNT, loaded.plugin, 1)
        this.#createProcess(plugin, loaded)
        if (this.#call(loaded, loaded.plugin + ClapAbi.Plugin.ACTIVATE, loaded.plugin, this.#sampleRate, RENDER_QUANTUM, RENDER_QUANTUM) === 0) {
            throw new Error("plugin.activate failed")
        }
        this.#onAudioThread(() => this.#call(loaded, loaded.plugin + ClapAbi.Plugin.START_PROCESSING, loaded.plugin))
        return loaded
    }

    // A bundle's optional `memory.json` names the heap it wants up front (`recommendedInitialBytes`)
    #recommendedInitialPages(bundle: WclapBundle): number {
        const file = bundle.files.find(({path}) => path === "memory.json")
        if (!isDefined(file)) {return 0}
        const parsed = tryCatch(() => JSON.parse(decodeUtf8(file.bytes)) as { recommendedInitialBytes?: number })
        if (parsed.status === "failure") {return 0}
        const bytes = parsed.value.recommendedInitialBytes
        return typeof bytes === "number" && bytes > 0 ? Math.ceil(bytes / 65536) : 0
    }

    #createHost(plugin: Plugin, loaded: Loaded): number {
        const {memory, malloc} = loaded
        const host = malloc(ClapAbi.Host.SIZE)
        const webviewExt = malloc(ClapAbi.HostWebview.SIZE)
        const logExt = malloc(ClapAbi.HostLog.SIZE)
        const threadCheckExt = malloc(ClapAbi.HostThreadCheck.SIZE)
        const stateExt = malloc(ClapAbi.HostState.SIZE)
        const extensions = new Map<string, number>([
            [ClapAbi.Ext.WEBVIEW, webviewExt], [ClapAbi.Ext.LOG, logExt],
            [ClapAbi.Ext.THREAD_CHECK, threadCheckExt], [ClapAbi.Ext.STATE, stateExt]
        ])
        this.#setFn(loaded, stateExt + ClapAbi.HostState.MARK_DIRTY, trampoline(["i32"], [],
            () => {plugin.dirtyCountdown = SAVE_DELAY_CHUNKS}))
        loaded.istream = malloc(ClapAbi.Stream.SIZE)
        loaded.ostream = malloc(ClapAbi.Stream.SIZE)
        this.#setFn(loaded, loaded.istream + ClapAbi.Stream.FN, trampoline(["i32", "i32", "i64"], ["i64"],
            (_stream: number, bufferPtr: number, size: bigint) => {
                const source = loaded.readSource
                if (isNull(source)) {return 0n}
                const count = Math.min(Number(size), source.bytes.length - source.cursor)
                new Uint8Array(memory.buffer).set(source.bytes.subarray(source.cursor, source.cursor + count), bufferPtr)
                source.cursor += count
                return BigInt(count)
            }))
        this.#setFn(loaded, loaded.ostream + ClapAbi.Stream.FN, trampoline(["i32", "i32", "i64"], ["i64"],
            (_stream: number, bufferPtr: number, size: bigint) => {
                loaded.writeChunks.push(new Uint8Array(memory.buffer, bufferPtr, Number(size)).slice())
                return size
            }))
        const view = new DataView(memory.buffer)
        view.setUint32(host, ClapAbi.VERSION.major, true)
        view.setUint32(host + 4, ClapAbi.VERSION.minor, true)
        view.setUint32(host + 8, ClapAbi.VERSION.revision, true)
        view.setUint32(host + ClapAbi.Host.HOST_DATA, 0, true)
        view.setUint32(host + ClapAbi.Host.NAME, this.#alloc(loaded, "openDAW"), true)
        view.setUint32(host + ClapAbi.Host.VENDOR, this.#alloc(loaded, "openDAW"), true)
        view.setUint32(host + ClapAbi.Host.URL, this.#alloc(loaded, "https://opendaw.studio"), true)
        view.setUint32(host + ClapAbi.Host.VERSION, this.#alloc(loaded, "0.1"), true)
        this.#setFn(loaded, host + ClapAbi.Host.GET_EXTENSION, trampoline(["i32", "i32"], ["i32"],
            (_host: number, idPtr: number) => extensions.get(this.#cstr(memory, idPtr)) ?? 0))
        this.#setFn(loaded, host + ClapAbi.Host.REQUEST_RESTART, trampoline(["i32"], [], () => {}))
        this.#setFn(loaded, host + ClapAbi.Host.REQUEST_PROCESS, trampoline(["i32"], [], () => {}))
        this.#setFn(loaded, host + ClapAbi.Host.REQUEST_CALLBACK, trampoline(["i32"], [], () => {}))
        this.#setFn(loaded, webviewExt + ClapAbi.HostWebview.SEND, trampoline(["i32", "i32", "i32"], ["i32"],
            (_host: number, bufferPtr: number, size: number) => {
                if (!plugin.guiOpen) {return 0}
                this.#sendGui(plugin.uuid, new Uint8Array(memory.buffer, bufferPtr, size).slice().buffer)
                return 1
            }))
        this.#setFn(loaded, logExt + ClapAbi.HostLog.LOG, trampoline(["i32", "i32", "i32"], [],
            (_host: number, severity: number, messagePtr: number) =>
                console.log(`[wclap ${plugin.clapId}] (${severity}) ${this.#cstr(memory, messagePtr)}`)))
        this.#setFn(loaded, threadCheckExt + ClapAbi.HostThreadCheck.IS_MAIN_THREAD, trampoline(["i32"], ["i32"], () => this.#inProcess ? 0 : 1))
        this.#setFn(loaded, threadCheckExt + ClapAbi.HostThreadCheck.IS_AUDIO_THREAD, trampoline(["i32"], ["i32"], () => this.#inProcess ? 1 : 0))
        return host
    }

    // Allocate the clap_process block once: two stereo audio buffers and empty event lists.
    #createProcess(plugin: Plugin, loaded: Loaded): void {
        const {memory, malloc} = loaded
        const processPtr = malloc(ClapAbi.Process.SIZE)
        const audioIn = malloc(ClapAbi.AudioBuffer.SIZE)
        const audioOut = malloc(ClapAbi.AudioBuffer.SIZE)
        const inData = malloc(8)
        const outData = malloc(8)
        loaded.inputs = [malloc(RENDER_QUANTUM * 4), malloc(RENDER_QUANTUM * 4)]
        loaded.outputs = [malloc(RENDER_QUANTUM * 4), malloc(RENDER_QUANTUM * 4)]
        const inEvents = malloc(ClapAbi.InputEvents.SIZE)
        const outEvents = malloc(ClapAbi.OutputEvents.SIZE)
        const view = new DataView(memory.buffer)
        view.setUint32(inData, loaded.inputs[0], true)
        view.setUint32(inData + 4, loaded.inputs[1], true)
        view.setUint32(outData, loaded.outputs[0], true)
        view.setUint32(outData + 4, loaded.outputs[1], true)
        for (const [buffer, data] of [[audioIn, inData], [audioOut, outData]]) {
            view.setUint32(buffer + ClapAbi.AudioBuffer.DATA32, data, true)
            view.setUint32(buffer + ClapAbi.AudioBuffer.DATA64, 0, true)
            view.setUint32(buffer + ClapAbi.AudioBuffer.CHANNEL_COUNT, 2, true)
            view.setUint32(buffer + ClapAbi.AudioBuffer.LATENCY, 0, true)
            view.setBigUint64(buffer + ClapAbi.AudioBuffer.CONSTANT_MASK, 0n, true)
        }
        loaded.eventsPtr = malloc(MAX_EVENTS * NOTE_EVENT_SIZE)
        view.setUint32(inEvents + ClapAbi.InputEvents.CTX, 0, true)
        this.#setFn(loaded, inEvents + ClapAbi.InputEvents.SIZE_FN, trampoline(["i32"], ["i32"], () => loaded.eventCount))
        this.#setFn(loaded, inEvents + ClapAbi.InputEvents.GET_FN, trampoline(["i32", "i32"], ["i32"],
            (_list: number, index: number) => index < loaded.eventCount ? loaded.eventsPtr + index * NOTE_EVENT_SIZE : 0))
        view.setUint32(outEvents + ClapAbi.OutputEvents.CTX, 0, true)
        this.#setFn(loaded, outEvents + ClapAbi.OutputEvents.TRY_PUSH_FN, trampoline(["i32", "i32"], ["i32"],
            (_list: number, eventPtr: number) => {
                const type = new DataView(memory.buffer).getUint16(eventPtr + ClapAbi.EventHeader.TYPE, true)
                if (type === ClapAbi.EventType.PARAM_VALUE) {plugin.dirtyCountdown = SAVE_DELAY_CHUNKS}
                return 1
            }))
        view.setBigInt64(processPtr + ClapAbi.Process.STEADY_TIME, 0n, true)
        view.setUint32(processPtr + ClapAbi.Process.FRAMES_COUNT, RENDER_QUANTUM, true)
        view.setUint32(processPtr + ClapAbi.Process.TRANSPORT, 0, true)
        view.setUint32(processPtr + ClapAbi.Process.AUDIO_INPUTS, audioIn, true)
        view.setUint32(processPtr + ClapAbi.Process.AUDIO_OUTPUTS, audioOut, true)
        view.setUint32(processPtr + ClapAbi.Process.AUDIO_INPUTS_COUNT, loaded.inputPorts > 0 ? 1 : 0, true)
        view.setUint32(processPtr + ClapAbi.Process.AUDIO_OUTPUTS_COUNT, 1, true)
        view.setUint32(processPtr + ClapAbi.Process.IN_EVENTS, inEvents, true)
        view.setUint32(processPtr + ClapAbi.Process.OUT_EVENTS, outEvents, true)
        loaded.processPtr = processPtr
        loaded.inEvents = inEvents
        loaded.outEvents = outEvents
    }

    // One chunk: engine memory -> plugin buffers -> process -> engine memory. 0 = not ready (passthrough cue).
    #process(handle: number, in0: number, in1: number, out0: number, out1: number, frames: number): number {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return 0}
        const loaded = plugin.loaded
        const engine = this.#memory.buffer
        const pluginBuffer = loaded.memory.buffer
        new Float32Array(pluginBuffer, loaded.inputs[0], frames).set(new Float32Array(engine, in0, frames))
        new Float32Array(pluginBuffer, loaded.inputs[1], frames).set(new Float32Array(engine, in1, frames))
        const view = new DataView(pluginBuffer)
        view.setBigInt64(loaded.processPtr + ClapAbi.Process.STEADY_TIME, loaded.steadyTime, true)
        view.setUint32(loaded.processPtr + ClapAbi.Process.FRAMES_COUNT, frames, true)
        loaded.steadyTime += BigInt(frames)
        this.#writeNotes(loaded, view)
        this.#onAudioThread(() => this.#call(loaded, loaded.plugin + ClapAbi.Plugin.PROCESS, loaded.plugin, loaded.processPtr))
        loaded.eventCount = 0
        plugin.receivedSinceProcess = false
        if (plugin.dirtyCountdown > 0 && --plugin.dirtyCountdown === 0) {
            plugin.dirtyCountdown = -1
            this.#saveState(plugin, loaded)
        }
        const after = loaded.memory.buffer
        new Float32Array(engine, out0, frames).set(new Float32Array(after, loaded.outputs[0], frames))
        new Float32Array(engine, out1, frames).set(new Float32Array(after, loaded.outputs[1], frames))
        return 1
    }

    #note(handle: number, on: boolean, key: number, velocity: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return}
        if (plugin.loaded.pendingNotes.length < MAX_EVENTS) {plugin.loaded.pendingNotes.push({on, key, velocity})}
    }

    // The queued notes as clap_event_note records at offset 0 of this chunk (the engine already split the
    // block at every event, see `wclap_note`).
    #writeNotes(loaded: Loaded, view: DataView): void {
        const notes = loaded.pendingNotes
        loaded.eventCount = notes.length
        notes.forEach(({on, key, velocity}, index) => {
            const ptr = loaded.eventsPtr + index * NOTE_EVENT_SIZE
            view.setUint32(ptr, NOTE_EVENT_SIZE, true)
            view.setUint32(ptr + ClapAbi.EventHeader.TIME, 0, true)
            view.setUint16(ptr + ClapAbi.EventHeader.SPACE_ID, 0, true)
            view.setUint16(ptr + ClapAbi.EventHeader.TYPE, on ? ClapAbi.EventType.NOTE_ON : ClapAbi.EventType.NOTE_OFF, true)
            view.setUint32(ptr + ClapAbi.EventHeader.FLAGS, 0, true)
            view.setInt32(ptr + ClapAbi.NoteEvent.NOTE_ID, -1, true)
            view.setInt16(ptr + ClapAbi.NoteEvent.PORT_INDEX, 0, true)
            view.setInt16(ptr + ClapAbi.NoteEvent.CHANNEL, 0, true)
            view.setInt16(ptr + ClapAbi.NoteEvent.KEY, key, true)
            view.setFloat64(ptr + ClapAbi.NoteEvent.VELOCITY, velocity, true)
        })
        notes.length = 0
    }

    #reset(handle: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return}
        const loaded = plugin.loaded
        this.#onAudioThread(() => this.#call(loaded, loaded.plugin + ClapAbi.Plugin.RESET, loaded.plugin))
    }

    #release(handle: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin)) {return}
        this.#destroy(plugin)
        this.#plugins.delete(handle)
        if (this.#byUuid.get(plugin.uuid) === handle) {this.#byUuid.delete(plugin.uuid)}
    }

    #destroy(plugin: Plugin): void {
        plugin.generation++
        plugin.loading = false
        const loaded = plugin.loaded
        if (isNull(loaded)) {return}
        plugin.loaded = null
        const pluginPtr = loaded.plugin
        this.#onAudioThread(() => this.#call(loaded, pluginPtr + ClapAbi.Plugin.STOP_PROCESSING, pluginPtr))
        this.#call(loaded, pluginPtr + ClapAbi.Plugin.DEACTIVATE, pluginPtr)
        this.#call(loaded, pluginPtr + ClapAbi.Plugin.DESTROY, pluginPtr)
    }

    #extension(loaded: Loaded, id: string): number {
        return this.#call(loaded, loaded.plugin + ClapAbi.Plugin.GET_EXTENSION, loaded.plugin, this.#alloc(loaded, id))
    }

    // CLAP's [audio-thread] calls, answered as such by the thread-check extension (clap-helpers asserts on it)
    #onAudioThread(procedure: () => void): void {
        this.#inProcess = true
        procedure()
        this.#inProcess = false
    }

    // `slotPtr` addresses a function-pointer field in plugin memory, its value is an index into the plugin's table
    #call(loaded: Loaded, slotPtr: number, ...args: Array<number | bigint>): number {
        const index = this.#u32(loaded.memory, slotPtr)
        const fn = loaded.table.get(index) as Optional<Function>
        if (!isDefined(fn)) {throw new Error(`null function pointer at ${slotPtr}`)}
        const result = fn(...args)
        return typeof result === "number" ? result : 0
    }

    #setFn(loaded: Loaded, slotPtr: number, fn: Function): void {
        const index = loaded.table.grow(1)
        loaded.table.set(index, fn)
        new DataView(loaded.memory.buffer).setUint32(slotPtr, index, true)
    }

    #alloc(loaded: Loaded, text: string): number {
        const bytes = encodeUtf8(text)
        const ptr = loaded.malloc(bytes.length + 1)
        const memory = new Uint8Array(loaded.memory.buffer)
        memory.set(bytes, ptr)
        memory[ptr + bytes.length] = 0
        return ptr
    }

    #u32(memory: WebAssembly.Memory, ptr: number): number {return new DataView(memory.buffer).getUint32(ptr, true)}

    #cstr(memory: WebAssembly.Memory, ptr: number): string {
        if (ptr === 0) {return ""}
        const bytes = new Uint8Array(memory.buffer)
        let end = ptr
        while (bytes[end] !== 0) {end++}
        return decodeUtf8(bytes.slice(ptr, end))
    }
}
