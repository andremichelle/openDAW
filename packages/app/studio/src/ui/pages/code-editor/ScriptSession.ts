import {DefaultObservableValue, MutableObservableOption, UUID} from "@opendaw/lib-std"
import {ScriptMeta} from "@opendaw/studio-core"
import {StarterScript} from "./StockScripts"

// Outlives the page like the monaco model does, so navigating away and back keeps the opened script
export namespace ScriptSession {
    export type Current = {uuid: UUID.Bytes, meta: ScriptMeta}
    export const current = new MutableObservableOption<Current>()
    export const savedSource = new DefaultObservableValue<string>(StarterScript.source)
    export const suggestedName = new DefaultObservableValue<string>("Untitled")
}
