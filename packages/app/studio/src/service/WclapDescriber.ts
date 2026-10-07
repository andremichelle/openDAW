import {WclapPluginInfo} from "@opendaw/studio-adapters"
import {WclapBundles, WclapStorage} from "@opendaw/studio-core"
import {createWclapDescriber} from "@opendaw/studio-core-wasm"

export type StoredWclapPlugin = { url: string, info: WclapPluginInfo }

// names and kinds of stored bundles without an engine, shared by the dashboard tab and the device editor
export namespace WclapDescriber {
    export type Kind = "audio-effect" | "instrument" | "note-effect"

    export const describe = createWclapDescriber(WclapBundles.fetch)

    export const kindOf = ({features}: WclapPluginInfo): Kind =>
        features.includes("instrument") ? "instrument" : features.includes("note-effect") ? "note-effect" : "audio-effect"

    export const shortKind = (kind: Kind): string => kind === "instrument" ? "Inst" : kind === "note-effect" ? "Note" : "Fx"

    export const stored = async (): Promise<ReadonlyArray<StoredWclapPlugin>> => {
        const ids = await WclapStorage.list()
        const lists = await Promise.all(ids.map(id => {
            const url = WclapStorage.urlOf(id)
            return describe(url).then(plugins => plugins.map(info => ({url, info})), () => [])
        }))
        return lists.flat()
    }
}
