// The JS host of a WCLAP plugin: a wasm32 CLAP module with its own memory, run next to the engine per device
import {isDefined, isNotNull, isNull, Nullable, Optional, Procedure, tryCatch, UUID} from "@opendaw/lib-std"
import {WclapBundle, WclapGuiInfo, WclapGuiSize, WclapParamGesture, WclapParamInfo, WclapPluginInfo, WclapStatus} from "@opendaw/studio-adapters"
import {decodeUtf8, encodeUtf8} from "../utf8"
import {ClapAbi} from "./clap-abi"
import {trampoline, TrampolineFn} from "./trampoline"
import {createWasiImports, readMemoryImportLimits} from "./wasi-shim"
import {decodeBase64} from "./base64"

export type WclapBundleLoader = (url: string) => Promise<WclapBundle>
export type WclapHostCallbacks = {
    loadBundle: WclapBundleLoader
    sendGui: (uuid: string, bytes: ArrayBuffer) => void
    sendState: (uuid: string, bytes: ArrayBuffer) => void
    sendParams: (uuid: string, params: ReadonlyArray<WclapParamInfo>) => void
    sendParam: (uuid: string, paramId: number, value: number, gesture: WclapParamGesture) => void
    sendHovered: (uuid: string, paramId: number) => void
    // clap.gui request_resize: the plugin's page wants another window size (logical pixels)
    requestGuiResize: (uuid: string, width: number, height: number) => void
    sendStatus: (uuid: string, status: WclapStatus) => void
    requestSave: (uuid: string) => void
    track: Procedure<Promise<unknown>>
}

const RENDER_QUANTUM = 128
const URI_CAPACITY = 2048
const MIN_INITIAL_PAGES = 256
const MAX_INITIAL_PAGES = 4096 // 256 MB up front at most, whatever memory.json recommends
const MAX_PAGES = 16384 // 1 GB, the most an untrusted module may grow to
const SAVE_DELAY_CHUNKS = 40 // ~100 ms of quiet after the last change before the state is saved
const MAX_PARAM_EVENTS = 128
const MAX_NOTE_EVENTS = 128
const EVENT_SLOT_SIZE = 48 // the largest record written (clap_event_param_value / param_mod)
const EVENT_SLOTS = MAX_PARAM_EVENTS * 2 + MAX_NOTE_EVENTS
const NOTE_EVENT_SIZE = 40
const MAX_MESSAGE_BYTES = 16 << 20
const LOG_LIMIT = 200 // console lines per plugin instance before its output is muted
const PARAM_KIND_UNIT = 0 // abi::PARAM_KIND_UNIT: a 0..1 automation value to map into the parameter's range
const PPQN_QUARTER = 960 // WASM CONTRACT: lib-dsp PPQN.Quarter
const BLOCK_FLAG_PLAYING = 1 << 2 // abi::BlockFlags::PLAYING

type Loaded = {
    memory: WebAssembly.Memory
    table: WebAssembly.Table
    malloc: (size: number) => number
    buffer: ArrayBuffer
    view: DataView
    audio: [Float32Array, Float32Array, Float32Array, Float32Array]
    plugin: number
    webview: number
    gui: number
    guiCreated: boolean
    processPtr: number
    transportPtr: number
    uriPtr: number
    sizePtr: number
    windowPtr: number
    inputs: [number, number]
    outputs: [number, number]
    inputPorts: number
    scratchPtr: number
    scratchSize: number
    steadyTime: number
    eventsPtr: number
    eventCount: number
    pendingNotes: Array<PendingNote>
    paramInfos: Map<number, WclapParamInfo>
    reported: Map<number, number> // last value per id the plugin reported (its GUI, a preset), f32
    lastModulation: Map<number, number> // last PARAM_MOD amount per id, to clear it once the sum returns to 0
    gestures: Set<number> // ids the plugin's GUI is dragging
    state: number
    params: number
    inEvents: number
    outEvents: number
    istream: number
    ostream: number
    readSource: Nullable<{ bytes: Uint8Array, cursor: number }>
    writeChunks: Array<Uint8Array>
    logCount: number
}

type PendingNote = { on: boolean, key: number, velocity: number }
type PendingParam = { kind: number, value: number, modulation: number }
type Booted = { memory: WebAssembly.Memory, table: WebAssembly.Table, malloc: (size: number) => number, entry: number }

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index])

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
    flushRequested: boolean = false
    pollPending: boolean = false
    // host-side values per clap id, kept before the plugin is up and pushed with its first process call
    readonly pendingParams = new Map<number, PendingParam>()

    constructor(uuid: string) {this.uuid = uuid}
}

export class WclapBridges {
    readonly #memory: WebAssembly.Memory
    readonly #host: WclapHostCallbacks
    readonly #sampleRate: number
    readonly #plugins = new Map<number, Plugin>()
    readonly #byUuid = new Map<string, number>()
    readonly #modules = new Map<string, Promise<{ module: WebAssembly.Module, bundle: WclapBundle }>>()
    readonly #described = new Map<string, Promise<ReadonlyArray<WclapPluginInfo>>>()
    #nextHandle: number = 1
    #inProcess: boolean = false

    constructor(memory: WebAssembly.Memory, sampleRate: number, host: WclapHostCallbacks) {
        this.#memory = memory
        this.#sampleRate = sampleRate
        this.#host = host
    }

    imports(): Record<string, (...args: Array<number>) => number | void> {
        return {
            host_wclap_create: (uuidPtr) => this.#create(uuidPtr),
            host_wclap_load: (handle, urlPtr, urlLen, idPtr, idLen) => this.#load(handle, urlPtr, urlLen, idPtr, idLen),
            host_wclap_process: (handle, in0, in1, out0, out1, frames, bpm, position, flags) =>
                this.#process(handle, in0, in1, out0, out1, frames, bpm, position, flags),
            host_wclap_note: (handle, on, key, velocity) => this.#note(handle, on !== 0, key, velocity),
            host_wclap_param: (handle, id, kind, value, modulation) => this.#param(handle, id >>> 0, kind, value, modulation), // u32 arrives signed
            host_wclap_state: (handle, ptr, len) => this.#state(handle, ptr, len),
            host_wclap_reset: (handle) => this.#reset(handle),
            host_wclap_release: (handle) => this.#release(handle)
        }
    }

    // Main-thread webview traffic, both between render quanta.
    receive(uuid: string, bytes: ArrayBuffer): void {
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin) || isNull(plugin.loaded) || plugin.loaded.webview === 0) {return}
        if (bytes.byteLength > MAX_MESSAGE_BYTES) {return}
        const loaded = plugin.loaded
        this.#contain(plugin, undefined, () => {
            const source = new Uint8Array(bytes)
            if (loaded.scratchSize < source.length) {
                loaded.scratchPtr = loaded.malloc(source.length)
                loaded.scratchSize = source.length
            }
            new Uint8Array(loaded.memory.buffer).set(source, loaded.scratchPtr)
            this.#call(loaded, loaded.webview + ClapAbi.Webview.RECEIVE, loaded.plugin, loaded.scratchPtr, source.length)
            plugin.dirtyCountdown = SAVE_DELAY_CHUNKS
            plugin.receivedSinceProcess = true
            plugin.pollPending = true
        })
    }

    // The webview's start page and the size the plugin asks for (clap.gui: create, get_size, set_parent, show)
    openGui(uuid: string): WclapGuiInfo {
        const none: WclapGuiInfo = {uri: "", width: 0, height: 0, resizable: false, aspectRatio: 0}
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin) || isNull(plugin.loaded) || plugin.loaded.webview === 0) {return none}
        const loaded = plugin.loaded
        return this.#contain(plugin, none, () => {
            const length = this.#call(loaded, loaded.webview + ClapAbi.Webview.GET_URI, loaded.plugin, loaded.uriPtr, URI_CAPACITY)
            if (length <= 0) {return none}
            const uri = this.#cstr(loaded.memory, loaded.uriPtr)
            const size = {width: 0, height: 0, resizable: false, aspectRatio: 0}
            if (loaded.gui !== 0 && !loaded.guiCreated) {
                const api = this.#alloc(loaded, ClapAbi.Gui.WINDOW_API_WEBVIEW)
                if (this.#call(loaded, loaded.gui + ClapAbi.Gui.CREATE, loaded.plugin, api, 0) !== 0) {
                    loaded.guiCreated = true
                    if (this.#call(loaded, loaded.gui + ClapAbi.Gui.GET_SIZE, loaded.plugin, loaded.sizePtr, loaded.sizePtr + 4) !== 0) {
                        size.width = this.#u32(loaded.memory, loaded.sizePtr)
                        size.height = this.#u32(loaded.memory, loaded.sizePtr + 4)
                    }
                    size.resizable = this.#hasFunction(loaded, loaded.gui + ClapAbi.Gui.CAN_RESIZE)
                        && this.#call(loaded, loaded.gui + ClapAbi.Gui.CAN_RESIZE, loaded.plugin) !== 0
                    size.aspectRatio = size.resizable ? this.#aspectRatio(loaded) : 0
                    this.#view(loaded).setUint32(loaded.windowPtr + ClapAbi.Window.API, api, true)
                    this.#view(loaded).setUint32(loaded.windowPtr + ClapAbi.Window.PTR, 0, true)
                    this.#call(loaded, loaded.gui + ClapAbi.Gui.SET_PARENT, loaded.plugin, loaded.windowPtr)
                    this.#call(loaded, loaded.gui + ClapAbi.Gui.SHOW, loaded.plugin)
                }
            }
            plugin.guiOpen = true
            return {uri, ...size}
        })
    }

    // clap.gui adjust_size then set_size, answers the size the plugin accepted
    resizeGui(uuid: string, width: number, height: number): WclapGuiSize {
        const requested: WclapGuiSize = {width, height}
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin) || isNull(plugin.loaded) || !plugin.loaded.guiCreated) {return requested}
        const loaded = plugin.loaded
        return this.#contain(plugin, requested, () => {
            const {gui, sizePtr} = loaded
            if (!this.#hasFunction(loaded, gui + ClapAbi.Gui.SET_SIZE)) {return requested}
            const view = this.#view(loaded)
            view.setUint32(sizePtr, Math.max(1, Math.round(width)), true)
            view.setUint32(sizePtr + 4, Math.max(1, Math.round(height)), true)
            if (this.#hasFunction(loaded, gui + ClapAbi.Gui.ADJUST_SIZE)) {
                this.#call(loaded, gui + ClapAbi.Gui.ADJUST_SIZE, loaded.plugin, sizePtr, sizePtr + 4)
            }
            const adjusted: WclapGuiSize = {width: this.#u32(loaded.memory, sizePtr), height: this.#u32(loaded.memory, sizePtr + 4)}
            if (this.#call(loaded, gui + ClapAbi.Gui.SET_SIZE, loaded.plugin, adjusted.width, adjusted.height) !== 0) {return adjusted}
            if (this.#call(loaded, gui + ClapAbi.Gui.GET_SIZE, loaded.plugin, sizePtr, sizePtr + 4) === 0) {return adjusted}
            return {width: this.#u32(loaded.memory, sizePtr), height: this.#u32(loaded.memory, sizePtr + 4)}
        })
    }

    #aspectRatio(loaded: Loaded): number {
        const {gui, sizePtr} = loaded
        if (!this.#hasFunction(loaded, gui + ClapAbi.Gui.GET_RESIZE_HINTS)) {return 0}
        if (this.#call(loaded, gui + ClapAbi.Gui.GET_RESIZE_HINTS, loaded.plugin, sizePtr) === 0) {return 0}
        const view = this.#view(loaded)
        if (view.getUint8(sizePtr + ClapAbi.ResizeHints.PRESERVE_ASPECT_RATIO) === 0) {return 0}
        const width = view.getUint32(sizePtr + ClapAbi.ResizeHints.ASPECT_RATIO_WIDTH, true)
        const height = view.getUint32(sizePtr + ClapAbi.ResizeHints.ASPECT_RATIO_HEIGHT, true)
        return width > 0 && height > 0 ? width / height : 0
    }

    // A plugin applies page messages only in process or flush, so flush first when nothing rendered since
    saveState(uuid: string): void {
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return}
        const loaded = plugin.loaded
        this.#contain(plugin, undefined, () => {
            if (plugin.receivedSinceProcess || plugin.flushRequested) {this.#flush(plugin, loaded)}
            this.#saveState(plugin, loaded, false)
        })
    }

    #flush(plugin: Plugin, loaded: Loaded): void {
        plugin.receivedSinceProcess = false
        plugin.flushRequested = false
        if (loaded.params === 0) {return}
        this.#writeEvents(plugin, loaded, this.#view(loaded))
        this.#onAudioThread(() => this.#call(loaded, loaded.params + ClapAbi.Params.FLUSH, loaded.plugin, loaded.inEvents, loaded.outEvents))
        loaded.eventCount = 0
    }

    closeGui(uuid: string): void {
        const plugin = this.#pluginByUuid(uuid)
        if (!isDefined(plugin)) {return}
        plugin.guiOpen = false
        const loaded = plugin.loaded
        if (isNull(loaded)) {return}
        this.#contain(plugin, undefined, () => this.#destroyGui(loaded))
    }

    #destroyGui(loaded: Loaded): void {
        if (!loaded.guiCreated) {return}
        loaded.guiCreated = false
        this.#call(loaded, loaded.gui + ClapAbi.Gui.HIDE, loaded.plugin)
        this.#call(loaded, loaded.gui + ClapAbi.Gui.DESTROY, loaded.plugin)
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
        if (plugin.url === url && plugin.clapId === clapId && (isNotNull(plugin.loaded) || plugin.loading)) {return}
        plugin.url = url
        plugin.clapId = clapId
        this.#destroy(plugin)
        if (url.length === 0 || clapId.length === 0) {return}
        const generation = ++plugin.generation
        plugin.loading = true
        this.#host.sendStatus(plugin.uuid, {state: "loading", message: ""})
        const load = this.#module(url)
            .then(({module}) => this.#instantiate(plugin, module))
            .then(loaded => {
                if (plugin.generation !== generation) {return}
                plugin.loaded = loaded
                plugin.loading = false
                this.#publishParams(plugin, loaded)
                this.#host.sendStatus(plugin.uuid, {state: "ready", message: ""})
            }, error => {
                if (plugin.generation !== generation) {return}
                plugin.loading = false
                this.#host.sendStatus(plugin.uuid, {state: "failed", message: describeError(error)})
            })
        this.#host.track(load)
    }

    #publishParams(plugin: Plugin, loaded: Loaded): void {
        const params = this.#readParams(loaded)
        loaded.paramInfos = new Map(params.map(param => [param.id, param]))
        this.#host.sendParams(plugin.uuid, params)
    }

    // The box's state blob, applied now or once the plugin is up, skipped when this bridge saved it itself
    #state(handle: number, ptr: number, len: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin)) {return}
        const bytes = decodeBase64(decodeUtf8(new Uint8Array(this.#memory.buffer, ptr, len).slice()))
        if (bytes.length === 0 || (isNotNull(plugin.knownState) && bytesEqual(plugin.knownState, bytes))) {return}
        plugin.pendingState = bytes
        const loaded = plugin.loaded
        if (isNotNull(loaded)) {this.#contain(plugin, undefined, () => this.#loadState(plugin, loaded))}
    }

    // The plugin's own re-serialisation becomes `knownState`, so a differing encoding is not a change
    #loadState(plugin: Plugin, loaded: Loaded): void {
        const bytes = plugin.pendingState
        plugin.pendingState = null
        if (isNull(bytes) || loaded.state === 0) {return}
        loaded.readSource = {bytes, cursor: 0}
        const ok = this.#call(loaded, loaded.state + ClapAbi.State.LOAD, loaded.plugin, loaded.istream)
        loaded.readSource = null
        plugin.knownState = bytes
        if (ok === 0) {
            this.#host.sendStatus(plugin.uuid, {state: "loading", message: `${plugin.clapId} rejected its saved state`})
            return
        }
        this.#saveState(plugin, loaded, true)
    }

    #saveState(plugin: Plugin, loaded: Loaded, silent: boolean): void {
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
        if (!silent) {this.#host.sendState(plugin.uuid, bytes.buffer)}
    }

    #module(url: string): Promise<{ module: WebAssembly.Module, bundle: WclapBundle }> {
        const cached = this.#modules.get(url)
        if (isDefined(cached)) {return cached}
        const promise = this.#host.loadBundle(url).then(async bundle => {
            const file = bundle.files.find(({path}) => path === "module.wasm")
            if (!isDefined(file)) {throw new Error(`no module.wasm in ${url}`)}
            const module = await WebAssembly.compile(file.bytes)
            return {module, bundle}
        })
        promise.catch(() => this.#modules.delete(url))
        this.#modules.set(url, promise)
        return promise
    }

    // The plugins a bundle's factory offers, once per url: a throwaway instance, entry init, descriptor walk
    describe(url: string): Promise<ReadonlyArray<WclapPluginInfo>> {
        const cached = this.#described.get(url)
        if (isDefined(cached)) {return cached}
        const promise = this.#describe(url)
        promise.catch(() => this.#described.delete(url))
        this.#described.set(url, promise)
        return promise
    }

    async #describe(url: string): Promise<ReadonlyArray<WclapPluginInfo>> {
        const {module, bundle} = await this.#module(url)
        const {memory, table, malloc, entry} = await this.#boot(module, bundle, "describe", () => {})
        const loaded = this.#emptyLoaded(memory, table, malloc)
        if (this.#call(loaded, entry + ClapAbi.PluginEntry.INIT, this.#alloc(loaded, "/describe")) === 0) {return []}
        const factory = this.#call(loaded, entry + ClapAbi.PluginEntry.GET_FACTORY, this.#alloc(loaded, ClapAbi.PluginFactory.ID))
        const count = factory === 0 ? 0 : this.#call(loaded, factory + ClapAbi.PluginFactory.GET_PLUGIN_COUNT, factory)
        const plugins = Array.from({length: count}, (_, index) => {
            const descriptor = this.#call(loaded, factory + ClapAbi.PluginFactory.GET_PLUGIN_DESCRIPTOR, factory, index)
            return {
                clapId: this.#cstr(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.ID)),
                name: this.#cstr(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.NAME)),
                vendor: this.#cstr(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.VENDOR)),
                features: this.#cstrList(memory, this.#u32(memory, descriptor + ClapAbi.PluginDescriptor.FEATURES))
            }
        })
        this.#call(loaded, entry + ClapAbi.PluginEntry.DEINIT)
        return plugins
    }

    // The loaded plugin's clap_param_info list, plain CLAP units.
    #readParams(loaded: Loaded): ReadonlyArray<WclapParamInfo> {
        if (loaded.params === 0) {return []}
        const count = this.#call(loaded, loaded.params + ClapAbi.Params.COUNT, loaded.plugin)
        const info = loaded.malloc(ClapAbi.ParamInfo.SIZE)
        const valueOut = loaded.malloc(8)
        const params: Array<WclapParamInfo> = []
        for (let index = 0; index < count; index++) {
            if (this.#call(loaded, loaded.params + ClapAbi.Params.GET_INFO, loaded.plugin, index, info) === 0) {continue}
            const view = new DataView(loaded.memory.buffer)
            const id = view.getUint32(info + ClapAbi.ParamInfo.ID, true)
            const defaultValue = view.getFloat64(info + ClapAbi.ParamInfo.DEFAULT_VALUE, true)
            const value = this.#call(loaded, loaded.params + ClapAbi.Params.GET_VALUE, loaded.plugin, id, valueOut) === 0
                ? defaultValue : view.getFloat64(valueOut, true)
            loaded.reported.set(id, Math.fround(value))
            params.push({
                id, defaultValue, value,
                flags: view.getUint32(info + ClapAbi.ParamInfo.FLAGS, true),
                name: this.#cstr(loaded.memory, info + ClapAbi.ParamInfo.NAME),
                module: this.#cstr(loaded.memory, info + ClapAbi.ParamInfo.MODULE),
                min: view.getFloat64(info + ClapAbi.ParamInfo.MIN_VALUE, true),
                max: view.getFloat64(info + ClapAbi.ParamInfo.MAX_VALUE, true)
            })
        }
        return params
    }

    // A fresh instance with its own memory (declared limits and memory.json, both capped) and WASI
    async #boot(module: WebAssembly.Module, bundle: WclapBundle, label: string, log: Procedure<string>): Promise<Booted> {
        const moduleBytes = bundle.files.find(({path}) => path === "module.wasm")?.bytes ?? new Uint8Array(0)
        const limits = readMemoryImportLimits(moduleBytes)
        const recommendedPages = Math.min(MAX_INITIAL_PAGES, this.#recommendedInitialPages(bundle))
        const imported = isDefined(limits)
            ? new WebAssembly.Memory({
                initial: Math.min(limits.maximum, MAX_PAGES, Math.max(limits.initial, MIN_INITIAL_PAGES, recommendedPages)),
                maximum: Math.min(limits.maximum, MAX_PAGES), shared: limits.shared
            })
            : undefined
        const memoryRef: { memory: Nullable<WebAssembly.Memory> } = {memory: imported ?? null}
        const wasi = createWasiImports(module, () => memoryRef.memory ?? new WebAssembly.Memory({initial: 1}), label, log)
        const imports: WebAssembly.Imports = {...wasi, env: isDefined(imported) ? {memory: imported} : {}}
        const instance = await WebAssembly.instantiate(module, imports)
        const exports = instance.exports as PluginExports
        const memory = exports.memory ?? imported
        if (!isDefined(memory)) {throw new Error("module neither imports nor exports a memory")}
        memoryRef.memory = memory
        if (!isDefined(exports.__indirect_function_table) || !isDefined(exports.malloc) || !isDefined(exports.clap_entry)) {
            throw new Error("module lacks __indirect_function_table, malloc or clap_entry")
        }
        exports._initialize?.()
        return {memory, table: exports.__indirect_function_table, malloc: exports.malloc, entry: exports.clap_entry.value}
    }

    #emptyLoaded(memory: WebAssembly.Memory, table: WebAssembly.Table, malloc: (size: number) => number): Loaded {
        return {
            memory, table, malloc, buffer: memory.buffer, view: new DataView(memory.buffer),
            audio: [new Float32Array(0), new Float32Array(0), new Float32Array(0), new Float32Array(0)],
            plugin: 0, webview: 0, gui: 0, guiCreated: false, processPtr: 0, transportPtr: 0, uriPtr: 0, sizePtr: 0, windowPtr: 0,
            inputs: [0, 0], outputs: [0, 0], inputPorts: 0, scratchPtr: 0, scratchSize: 0, steadyTime: 0,
            eventsPtr: 0, eventCount: 0, pendingNotes: [], paramInfos: new Map(), reported: new Map(), lastModulation: new Map(),
            gestures: new Set(), state: 0, params: 0, inEvents: 0, outEvents: 0, istream: 0, ostream: 0,
            readSource: null, writeChunks: [], logCount: 0
        }
    }

    async #instantiate(plugin: Plugin, module: WebAssembly.Module): Promise<Loaded> {
        const bundle = (await this.#module(plugin.url)).bundle
        const holder: { loaded: Nullable<Loaded> } = {loaded: null}
        const log = (line: string): void => {if (isNotNull(holder.loaded)) {this.#log(plugin, holder.loaded, line)}}
        const {memory, table, malloc, entry} = await this.#boot(module, bundle, plugin.clapId, log)
        const loaded = this.#emptyLoaded(memory, table, malloc)
        holder.loaded = loaded
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
        loaded.uriPtr = malloc(URI_CAPACITY)
        loaded.sizePtr = malloc(ClapAbi.ResizeHints.SIZE)
        loaded.windowPtr = malloc(ClapAbi.Window.SIZE)
        this.#loadState(plugin, loaded)
        const audioPorts = this.#extension(loaded, ClapAbi.Ext.AUDIO_PORTS)
        loaded.inputPorts = audioPorts === 0 ? 1 : this.#call(loaded, audioPorts + ClapAbi.AudioPorts.COUNT, loaded.plugin, 1)
        this.#createProcess(plugin, loaded)
        // the engine splits blocks at events, so a chunk may hold any 1..128 frames
        if (this.#call(loaded, loaded.plugin + ClapAbi.Plugin.ACTIVATE, loaded.plugin, this.#sampleRate, 1, RENDER_QUANTUM) === 0) {
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

    #log(plugin: Plugin, loaded: Loaded, line: string): void {
        if (loaded.logCount > LOG_LIMIT) {return}
        if (loaded.logCount++ === LOG_LIMIT) {
            console.log(`[wclap ${plugin.clapId}] further output muted`)
            return
        }
        console.log(`[wclap ${plugin.clapId}] ${line}`)
    }

    #createHost(plugin: Plugin, loaded: Loaded): number {
        const {memory, malloc} = loaded
        const host = malloc(ClapAbi.Host.SIZE)
        const webviewExt = malloc(ClapAbi.HostWebview.SIZE)
        const logExt = malloc(ClapAbi.HostLog.SIZE)
        const threadCheckExt = malloc(ClapAbi.HostThreadCheck.SIZE)
        const stateExt = malloc(ClapAbi.HostState.SIZE)
        const hoveredExt = malloc(ClapAbi.HostParamHovered.SIZE)
        const guiExt = malloc(ClapAbi.HostGui.SIZE)
        const paramsExt = malloc(ClapAbi.HostParams.SIZE)
        const extensions = new Map<string, number>([
            [ClapAbi.Ext.WEBVIEW, webviewExt], [ClapAbi.Ext.LOG, logExt],
            [ClapAbi.Ext.THREAD_CHECK, threadCheckExt], [ClapAbi.Ext.STATE, stateExt],
            [ClapAbi.Ext.PARAM_HOVERED, hoveredExt], [ClapAbi.Ext.HOST_PARAMS, paramsExt], [ClapAbi.Ext.GUI, guiExt]
        ])
        this.#setFn(loaded, hoveredExt + ClapAbi.HostParamHovered.UPDATE, trampoline(["i32", "i32"], [],
            (_host: number, paramId: number) => this.#host.sendHovered(plugin.uuid, paramId === ClapAbi.INVALID_ID ? -1 : paramId)))
        this.#setFn(loaded, guiExt + ClapAbi.HostGui.RESIZE_HINTS_CHANGED, trampoline(["i32"], [], () => {}))
        this.#setFn(loaded, guiExt + ClapAbi.HostGui.REQUEST_RESIZE, trampoline(["i32", "i32", "i32"], ["i32"],
            (_host: number, width: number, height: number) => {
                if (!plugin.guiOpen || width <= 0 || height <= 0) {return 0}
                this.#host.requestGuiResize(plugin.uuid, width, height)
                return 1
            }))
        this.#setFn(loaded, guiExt + ClapAbi.HostGui.REQUEST_SHOW, trampoline(["i32"], ["i32"], () => 0))
        this.#setFn(loaded, guiExt + ClapAbi.HostGui.REQUEST_HIDE, trampoline(["i32"], ["i32"], () => 0))
        this.#setFn(loaded, guiExt + ClapAbi.HostGui.CLOSED, trampoline(["i32", "i32"], [], () => {}))
        this.#setFn(loaded, stateExt + ClapAbi.HostState.MARK_DIRTY, trampoline(["i32"], [],
            () => {plugin.dirtyCountdown = SAVE_DELAY_CHUNKS}))
        this.#setFn(loaded, paramsExt + ClapAbi.HostParams.RESCAN, trampoline(["i32", "i32"], [],
            () => {if (plugin.loaded === loaded && !this.#inProcess) {this.#publishParams(plugin, loaded)}}))
        this.#setFn(loaded, paramsExt + ClapAbi.HostParams.CLEAR, trampoline(["i32", "i32", "i32"], [], () => {}))
        this.#setFn(loaded, paramsExt + ClapAbi.HostParams.REQUEST_FLUSH, trampoline(["i32"], [],
            () => {plugin.flushRequested = true}))
        loaded.istream = malloc(ClapAbi.Stream.SIZE)
        loaded.ostream = malloc(ClapAbi.Stream.SIZE)
        this.#setFn(loaded, loaded.istream + ClapAbi.Stream.FN, trampoline(["i32", "i32", "i64"], ["i64"],
            (_stream: number, bufferPtr: number, size: bigint) => {
                const source = loaded.readSource
                if (isNull(source)) {return 0n}
                const room = Math.max(0, memory.buffer.byteLength - bufferPtr)
                const count = Math.min(Number(size), room, source.bytes.length - source.cursor)
                new Uint8Array(memory.buffer).set(source.bytes.subarray(source.cursor, source.cursor + count), bufferPtr)
                source.cursor += count
                return BigInt(count)
            }))
        this.#setFn(loaded, loaded.ostream + ClapAbi.Stream.FN, trampoline(["i32", "i32", "i64"], ["i64"],
            (_stream: number, bufferPtr: number, size: bigint) => {
                const count = Math.min(Number(size), Math.max(0, memory.buffer.byteLength - bufferPtr))
                loaded.writeChunks.push(new Uint8Array(memory.buffer, bufferPtr, count).slice())
                return BigInt(count)
            }))
        const view = this.#view(loaded)
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
                const count = Math.min(size, Math.max(0, memory.buffer.byteLength - bufferPtr))
                this.#host.sendGui(plugin.uuid, new Uint8Array(memory.buffer, bufferPtr, count).slice().buffer)
                return 1
            }))
        this.#setFn(loaded, logExt + ClapAbi.HostLog.LOG, trampoline(["i32", "i32", "i32"], [],
            (_host: number, severity: number, messagePtr: number) =>
                this.#log(plugin, loaded, `(${severity}) ${this.#cstr(memory, messagePtr)}`)))
        this.#setFn(loaded, threadCheckExt + ClapAbi.HostThreadCheck.IS_MAIN_THREAD, trampoline(["i32"], ["i32"], () => this.#inProcess ? 0 : 1))
        this.#setFn(loaded, threadCheckExt + ClapAbi.HostThreadCheck.IS_AUDIO_THREAD, trampoline(["i32"], ["i32"], () => this.#inProcess ? 1 : 0))
        return host
    }

    // Allocate the clap_process block once: two stereo audio buffers, the event lists and a transport event
    #createProcess(plugin: Plugin, loaded: Loaded): void {
        const {malloc} = loaded
        const processPtr = malloc(ClapAbi.Process.SIZE)
        const audioIn = malloc(ClapAbi.AudioBuffer.SIZE)
        const audioOut = malloc(ClapAbi.AudioBuffer.SIZE)
        const inData = malloc(8)
        const outData = malloc(8)
        loaded.inputs = [malloc(RENDER_QUANTUM * 4), malloc(RENDER_QUANTUM * 4)]
        loaded.outputs = [malloc(RENDER_QUANTUM * 4), malloc(RENDER_QUANTUM * 4)]
        const inEvents = malloc(ClapAbi.InputEvents.SIZE)
        const outEvents = malloc(ClapAbi.OutputEvents.SIZE)
        loaded.transportPtr = malloc(ClapAbi.TransportEvent.SIZE)
        const view = this.#view(loaded)
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
        new Uint8Array(loaded.memory.buffer, loaded.transportPtr, ClapAbi.TransportEvent.SIZE).fill(0)
        view.setUint32(loaded.transportPtr, ClapAbi.TransportEvent.SIZE, true)
        view.setUint16(loaded.transportPtr + ClapAbi.EventHeader.TYPE, ClapAbi.EventType.TRANSPORT, true)
        view.setUint16(loaded.transportPtr + ClapAbi.TransportEvent.TSIG_NUM, 4, true)
        view.setUint16(loaded.transportPtr + ClapAbi.TransportEvent.TSIG_DENOM, 4, true)
        loaded.eventsPtr = malloc(EVENT_SLOTS * EVENT_SLOT_SIZE)
        view.setUint32(inEvents + ClapAbi.InputEvents.CTX, 0, true)
        this.#setFn(loaded, inEvents + ClapAbi.InputEvents.SIZE_FN, trampoline(["i32"], ["i32"], () => loaded.eventCount))
        this.#setFn(loaded, inEvents + ClapAbi.InputEvents.GET_FN, trampoline(["i32", "i32"], ["i32"],
            (_list: number, index: number) => index < loaded.eventCount ? loaded.eventsPtr + index * EVENT_SLOT_SIZE : 0))
        view.setUint32(outEvents + ClapAbi.OutputEvents.CTX, 0, true)
        this.#setFn(loaded, outEvents + ClapAbi.OutputEvents.TRY_PUSH_FN, trampoline(["i32", "i32"], ["i32"],
            (_list: number, eventPtr: number) => {
                const eventView = this.#view(loaded)
                const type = eventView.getUint16(eventPtr + ClapAbi.EventHeader.TYPE, true)
                const paramId = eventView.getUint32(eventPtr + ClapAbi.ParamValueEvent.PARAM_ID, true)
                if (type === ClapAbi.EventType.PARAM_VALUE) {
                    plugin.dirtyCountdown = SAVE_DELAY_CHUNKS
                    const value = eventView.getFloat64(eventPtr + ClapAbi.ParamValueEvent.VALUE, true)
                    loaded.reported.set(paramId, Math.fround(value))
                    this.#host.sendParam(plugin.uuid, paramId, value, 0)
                } else if (type === ClapAbi.EventType.PARAM_GESTURE_BEGIN) {
                    loaded.gestures.add(paramId)
                    this.#host.sendParam(plugin.uuid, paramId, 0, 1)
                } else if (type === ClapAbi.EventType.PARAM_GESTURE_END) {
                    loaded.gestures.delete(paramId)
                    this.#host.sendParam(plugin.uuid, paramId, 0, 2)
                }
                return 1
            }))
        view.setBigInt64(processPtr + ClapAbi.Process.STEADY_TIME, 0n, true)
        view.setUint32(processPtr + ClapAbi.Process.FRAMES_COUNT, RENDER_QUANTUM, true)
        view.setUint32(processPtr + ClapAbi.Process.TRANSPORT, loaded.transportPtr, true)
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

    // One chunk through the plugin, 0 = not ready (the device passes through)
    #process(handle: number, in0: number, in1: number, out0: number, out1: number, frames: number,
             bpm: number, position: number, flags: number): number {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return 0}
        const loaded = plugin.loaded
        return this.#contain(plugin, 0, () => {
            const engine = this.#memory.buffer
            const [inLeft, inRight, outLeft, outRight] = this.#audio(loaded)
            inLeft.set(new Float32Array(engine, in0, frames))
            inRight.set(new Float32Array(engine, in1, frames))
            const view = this.#view(loaded)
            this.#writeU64(view, loaded.processPtr + ClapAbi.Process.STEADY_TIME, loaded.steadyTime)
            view.setUint32(loaded.processPtr + ClapAbi.Process.FRAMES_COUNT, frames, true)
            loaded.steadyTime += frames
            this.#writeTransport(loaded, view, bpm, position, flags)
            this.#writeEvents(plugin, loaded, view)
            this.#onAudioThread(() => this.#call(loaded, loaded.plugin + ClapAbi.Plugin.PROCESS, loaded.plugin, loaded.processPtr))
            loaded.eventCount = 0
            plugin.receivedSinceProcess = false
            plugin.flushRequested = false
            if (plugin.pollPending) {
                plugin.pollPending = false
                this.#pollParams(plugin, loaded)
            }
            if (plugin.dirtyCountdown > 0 && --plugin.dirtyCountdown === 0) {
                plugin.dirtyCountdown = -1
                this.#host.requestSave(plugin.uuid)
            }
            const [, , afterLeft, afterRight] = this.#audio(loaded)
            new Float32Array(engine, out0, frames).set(afterLeft.subarray(0, frames))
            new Float32Array(engine, out1, frames).set(afterRight.subarray(0, frames))
            return 1
        })
    }

    // Cmajor emits no parameter events for page edits
    #pollParams(plugin: Plugin, loaded: Loaded): void {
        if (loaded.params === 0) {return}
        const view = this.#view(loaded)
        for (const info of loaded.paramInfos.values()) {
            if (this.#call(loaded, loaded.params + ClapAbi.Params.GET_VALUE, loaded.plugin, info.id, loaded.sizePtr) === 0) {continue}
            const value = view.getFloat64(loaded.sizePtr, true)
            if (loaded.reported.get(info.id) === Math.fround(value)) {continue}
            loaded.reported.set(info.id, Math.fround(value))
            this.#host.sendParam(plugin.uuid, info.id, value, 0)
        }
    }

    #writeTransport(loaded: Loaded, view: DataView, bpm: number, position: number, flags: number): void {
        const playing = (flags & BLOCK_FLAG_PLAYING) !== 0
        const transportFlags = ClapAbi.TransportEvent.HAS_TEMPO | ClapAbi.TransportEvent.HAS_BEATS_TIMELINE
            | (playing ? ClapAbi.TransportEvent.IS_PLAYING : 0)
        view.setUint32(loaded.transportPtr + ClapAbi.TransportEvent.FLAGS, transportFlags, true)
        view.setFloat64(loaded.transportPtr + ClapAbi.TransportEvent.TEMPO, bpm, true)
        this.#writeU64(view, loaded.transportPtr + ClapAbi.TransportEvent.SONG_POS_BEATS,
            Math.max(0, Math.round(position / PPQN_QUARTER * ClapAbi.TransportEvent.BEATTIME_FACTOR)))
    }

    // A non-negative integer below 2^53 as two u32 halves, no BigInt on the render path
    #writeU64(view: DataView, ptr: number, value: number): void {
        view.setUint32(ptr, value >>> 0, true)
        view.setUint32(ptr + 4, Math.floor(value / 4294967296) >>> 0, true)
    }

    #note(handle: number, on: boolean, key: number, velocity: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return}
        const notes = plugin.loaded.pendingNotes
        if (notes.length < MAX_NOTE_EVENTS) {notes.push({on, key, velocity})}
    }

    // The last host value per id wins per chunk, kept before the plugin is up for its first process call
    #param(handle: number, id: number, kind: number, value: number, modulation: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin)) {return}
        const pending = plugin.pendingParams.get(id)
        if (isDefined(pending)) {
            pending.kind = kind
            pending.value = value
            pending.modulation = modulation
        } else {
            plugin.pendingParams.set(id, {kind, value, modulation})
        }
        plugin.receivedSinceProcess = true
    }

    // Parameter changes and notes as events at offset 0, modulation as PARAM_MOD where allowed, else folded
    #writeEvents(plugin: Plugin, loaded: Loaded, view: DataView): void {
        const state = {count: 0}
        const header = (type: number, size: number): number => {
            const ptr = loaded.eventsPtr + state.count++ * EVENT_SLOT_SIZE
            view.setUint32(ptr, size, true)
            view.setUint32(ptr + ClapAbi.EventHeader.TIME, 0, true)
            view.setUint16(ptr + ClapAbi.EventHeader.SPACE_ID, 0, true)
            view.setUint16(ptr + ClapAbi.EventHeader.TYPE, type, true)
            view.setUint32(ptr + ClapAbi.EventHeader.FLAGS, 0, true)
            return ptr
        }
        const paramEvent = (type: number, id: number, amount: number): void => {
            // a host value is no plugin change, else a folded modulation drifts the base
            if (type === ClapAbi.EventType.PARAM_VALUE) {loaded.reported.set(id, Math.fround(amount))}
            const ptr = header(type, ClapAbi.ParamValueEvent.SIZE)
            view.setUint32(ptr + ClapAbi.ParamValueEvent.PARAM_ID, id, true)
            view.setUint32(ptr + ClapAbi.ParamValueEvent.COOKIE, 0, true)
            view.setInt32(ptr + ClapAbi.ParamValueEvent.NOTE_ID, -1, true)
            view.setInt16(ptr + ClapAbi.ParamValueEvent.PORT_INDEX, -1, true)
            view.setInt16(ptr + ClapAbi.ParamValueEvent.CHANNEL, -1, true)
            view.setInt16(ptr + ClapAbi.ParamValueEvent.KEY, -1, true)
            view.setFloat64(ptr + ClapAbi.ParamValueEvent.VALUE, amount, true)
        }
        const written = {params: 0}
        for (const [id, {kind, value: raw, modulation: sum}] of plugin.pendingParams) {
            if (written.params === MAX_PARAM_EVENTS) {break}
            plugin.pendingParams.delete(id)
            const info = loaded.paramInfos.get(id)
            if (!isDefined(info) || loaded.gestures.has(id)) {continue}
            const range = info.max - info.min
            const value = kind === PARAM_KIND_UNIT ? info.min + raw * range : raw
            const modulation = isNaN(sum) ? 0 : sum * range
            const modulatable = (info.flags & ClapAbi.ParamFlags.IS_MODULATABLE) !== 0
            const last = loaded.lastModulation.get(id) ?? 0
            if (modulation === 0 && last === 0 && loaded.reported.get(id) === Math.fround(value)) {continue}
            written.params++
            if (modulatable) {
                paramEvent(ClapAbi.EventType.PARAM_VALUE, id, value)
                if (modulation !== 0 || last !== 0) {paramEvent(ClapAbi.EventType.PARAM_MOD, id, modulation)}
                loaded.lastModulation.set(id, modulation)
            } else {
                paramEvent(ClapAbi.EventType.PARAM_VALUE, id, Math.min(info.max, Math.max(info.min, value + modulation)))
            }
        }
        this.#writeNotes(loaded, view, state)
        loaded.eventCount = state.count
    }

    #writeNotes(loaded: Loaded, view: DataView, state: { count: number }): void {
        for (const {on, key, velocity} of loaded.pendingNotes) {
            const ptr = loaded.eventsPtr + state.count++ * EVENT_SLOT_SIZE
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
        }
        loaded.pendingNotes.length = 0
    }

    #reset(handle: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin) || isNull(plugin.loaded)) {return}
        const loaded = plugin.loaded
        loaded.steadyTime = 0
        loaded.pendingNotes.length = 0
        this.#contain(plugin, undefined, () =>
            this.#onAudioThread(() => this.#call(loaded, loaded.plugin + ClapAbi.Plugin.RESET, loaded.plugin)))
    }

    #release(handle: number): void {
        const plugin = this.#plugins.get(handle)
        if (!isDefined(plugin)) {return}
        this.#destroy(plugin)
        this.#plugins.delete(handle)
        if (this.#byUuid.get(plugin.uuid) === handle) {this.#byUuid.delete(plugin.uuid)}
    }

    // The last known state survives the teardown for a re-instantiation
    #destroy(plugin: Plugin): void {
        plugin.generation++
        plugin.loading = false
        const loaded = plugin.loaded
        if (isNull(loaded)) {return}
        plugin.loaded = null
        plugin.pendingState = plugin.knownState ?? plugin.pendingState
        plugin.knownState = null
        const pluginPtr = loaded.plugin
        this.#contain(plugin, undefined, () => {
            this.#destroyGui(loaded)
            this.#onAudioThread(() => this.#call(loaded, pluginPtr + ClapAbi.Plugin.STOP_PROCESSING, pluginPtr))
            this.#call(loaded, pluginPtr + ClapAbi.Plugin.DEACTIVATE, pluginPtr)
            this.#call(loaded, pluginPtr + ClapAbi.Plugin.DESTROY, pluginPtr)
        })
    }

    // A trap or throw inside the plugin drops the instance, the engine is untouched
    #contain<T>(plugin: Plugin, fallback: T, exec: () => T): T {
        const result = tryCatch(exec)
        if (result.status === "success") {return result.value}
        this.#inProcess = false
        plugin.generation++
        plugin.loading = false
        plugin.loaded = null
        plugin.pendingState = plugin.knownState ?? plugin.pendingState
        plugin.knownState = null
        console.error(`[wclap ${plugin.clapId}]`, result.error)
        this.#host.sendStatus(plugin.uuid, {state: "failed", message: describeError(result.error)})
        return fallback
    }

    #extension(loaded: Loaded, id: string): number {
        return this.#call(loaded, loaded.plugin + ClapAbi.Plugin.GET_EXTENSION, loaded.plugin, this.#alloc(loaded, id))
    }

    // CLAP's [audio-thread] calls, answered as such by the thread-check extension (clap-helpers asserts on it)
    #onAudioThread(procedure: () => void): void {
        this.#inProcess = true
        const result = tryCatch(procedure)
        this.#inProcess = false
        if (result.status === "failure") {throw result.error}
    }

    // The plugin memory's DataView and audio views, renewed after the memory grew (a grow detaches them)
    #view(loaded: Loaded): DataView {
        if (loaded.buffer !== loaded.memory.buffer) {this.#refreshViews(loaded)}
        return loaded.view
    }

    #audio(loaded: Loaded): Loaded["audio"] {
        if (loaded.buffer !== loaded.memory.buffer || loaded.audio[0].length === 0) {this.#refreshViews(loaded)}
        return loaded.audio
    }

    #refreshViews(loaded: Loaded): void {
        const buffer = loaded.memory.buffer
        loaded.buffer = buffer
        loaded.view = new DataView(buffer)
        loaded.audio = loaded.inputs[0] === 0 ? loaded.audio : [
            new Float32Array(buffer, loaded.inputs[0], RENDER_QUANTUM), new Float32Array(buffer, loaded.inputs[1], RENDER_QUANTUM),
            new Float32Array(buffer, loaded.outputs[0], RENDER_QUANTUM), new Float32Array(buffer, loaded.outputs[1], RENDER_QUANTUM)
        ]
    }

    // `slotPtr` addresses a function-pointer field in plugin memory, its value is an index into the plugin's table
    #hasFunction(loaded: Loaded, slotPtr: number): boolean {
        const index = this.#u32(loaded.memory, slotPtr)
        return index !== 0 && index < loaded.table.length && typeof loaded.table.get(index) === "function"
    }

    #call(loaded: Loaded, slotPtr: number, ...args: Array<number | bigint>): number {
        const index = this.#u32(loaded.memory, slotPtr)
        const fn: unknown = index < loaded.table.length ? loaded.table.get(index) : null
        if (typeof fn !== "function") {throw new Error(`null function pointer at ${slotPtr}`)}
        const result: unknown = fn(...args)
        return typeof result === "number" ? result : 0
    }

    #setFn(loaded: Loaded, slotPtr: number, fn: TrampolineFn): void {
        const index = loaded.table.grow(1)
        loaded.table.set(index, fn)
        this.#view(loaded).setUint32(slotPtr, index, true)
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

    // A NUL-terminated string, bounded by the memory's end
    #cstr(memory: WebAssembly.Memory, ptr: number): string {
        if (ptr === 0) {return ""}
        const bytes = new Uint8Array(memory.buffer)
        const end = bytes.indexOf(0, ptr)
        return decodeUtf8(bytes.slice(ptr, end === -1 ? bytes.length : end))
    }

    // A NULL-terminated array of string pointers (clap_plugin_descriptor.features), bounded by the memory's end
    #cstrList(memory: WebAssembly.Memory, ptr: number): Array<string> {
        const list: Array<string> = []
        const view = new DataView(memory.buffer)
        for (const entry of Array.from({length: 64}, (_, index) => ptr + index * 4)) {
            if (ptr === 0 || entry + 4 > memory.buffer.byteLength) {break}
            const text = view.getUint32(entry, true)
            if (text === 0) {break}
            list.push(this.#cstr(memory, text))
        }
        return list
    }
}

type PluginExports = {
    memory?: WebAssembly.Memory
    __indirect_function_table?: WebAssembly.Table
    malloc?: (size: number) => number
    _initialize?: () => void
    clap_entry?: WebAssembly.Global
}

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error)
