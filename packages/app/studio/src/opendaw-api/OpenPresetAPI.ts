import {
    asDefined, isDefined, Lazy, panic, Procedure, tryCatch, unitValue, UUID
} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {Browser} from "@opendaw/lib-dom"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories, PresetMeta} from "@opendaw/studio-core"
import {OpenDAWHeaders} from "./OpenDAWHeaders"
import {CommunityIndex, PresetDevices} from "./CommunityIndex"

const Devices: PresetDevices = {
    isInstrument: (key: string): key is InstrumentFactories.Keys => Object.hasOwn(InstrumentFactories.Named, key),
    isAudioEffect: (key: string): key is EffectFactories.AudioEffectKeys => Object.hasOwn(EffectFactories.AudioNamed, key),
    isMidiEffect: (key: string): key is EffectFactories.MidiEffectKeys => Object.hasOwn(EffectFactories.MidiNamed, key)
}

export class OpenPresetAPI {
    static readonly FileRoot = "https://assets.opendaw.studio/community"

    @Lazy
    static get(): OpenPresetAPI {return new OpenPresetAPI()}

    // presets for the next release are only listed on dev.opendaw.studio and localhost
    static readsDevPresets(): boolean {return Browser.isLocalHost() || location.origin.includes("dev.opendaw.studio")}

    readonly #files: Map<string, string>

    private constructor() {this.#files = new Map()}

    @Lazy
    async list(): Promise<ReadonlyArray<PresetMeta>> {
        const groups = OpenPresetAPI.readsDevPresets() ? ["presets", "dev/presets"] : ["presets"]
        const lists = await Promise.all(groups.map(group => this.#listGroup(group)))
        const presets = lists.flat()
        console.info(`OpenPresetAPI.list loaded ${presets.length} stock preset(s)`)
        return presets
    }

    async #listGroup(group: string): Promise<ReadonlyArray<PresetMeta>> {
        const url = `${OpenPresetAPI.FileRoot}/${group}/index.json?t=${Date.now()}`
        const result = await Promises.tryCatch(Promises.retry(() =>
            network.defaultFetch(url, OpenDAWHeaders).then(response => response.json())))
        if (result.status === "rejected") {
            console.warn("OpenPresetAPI.list fetch failed", url, result.error)
            return []
        }
        const parsed = tryCatch(() => CommunityIndex.parsePresets(result.value))
        if (parsed.status === "failure") {
            console.warn("OpenPresetAPI.list unexpected payload", url, parsed.error)
            return []
        }
        return parsed.value.flatMap(entry => CommunityIndex.toPresetMeta(entry, Devices).match({
            none: () => [],
            some: meta => {
                this.#files.set(entry.uuid, `${group}/${entry.url}`)
                return [meta]
            }
        }))
    }

    async load(uuid: UUID.Bytes,
               progress?: Procedure<unitValue>,
               signal?: AbortSignal): Promise<ArrayBuffer> {
        await this.list()
        const file = this.#files.get(UUID.toString(uuid))
        if (!isDefined(file)) {return panic(`Unknown stock preset ${UUID.toString(uuid)}`)}
        const url = `${OpenPresetAPI.FileRoot}/${file}`
        // Cancellable fetches skip the auto-retry: a user-cancelled download
        // must not silently retry after the dialog has already closed.
        const response = isDefined(signal)
            ? await network.limitFetch(url, {...OpenDAWHeaders, signal})
            : await Promises.retry(() => network.limitFetch(url, OpenDAWHeaders))
        if (!response.ok) {
            return panic(`Failed to fetch preset ${UUID.toString(uuid)}: ${response.status} ${response.statusText}`)
        }
        if (!isDefined(progress)) {return response.arrayBuffer()}
        const total = parseInt(response.headers.get("Content-Length") ?? "0")
        let loaded = 0
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = asDefined(response.body, "No body in response").getReader()
            const chunks: Array<Uint8Array> = []
            const onAbort = () => reader.cancel().catch(() => {})
            if (isDefined(signal)) {signal.addEventListener("abort", onAbort, {once: true})}
            const cleanup = () => {
                if (isDefined(signal)) {signal.removeEventListener("abort", onAbort)}
            }
            const nextChunk = ({done, value}: ReadableStreamReadResult<Uint8Array>) => {
                if (done) {
                    cleanup()
                    resolve(new Blob(chunks as Array<BlobPart>).arrayBuffer())
                } else {
                    chunks.push(value)
                    loaded += value.length
                    progress(total > 0.0 ? loaded / total : 0.5)
                    reader.read().then(nextChunk, reason => {cleanup(); reject(reason)})
                }
            }
            reader.read().then(nextChunk, reason => {cleanup(); reject(reason)})
        })
    }
}
