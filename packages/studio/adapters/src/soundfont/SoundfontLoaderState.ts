import {unitValue} from "@opendaw/lib-std"

export type SoundfontLoaderState =
    | { readonly type: "idle" }
    | { readonly type: "progress", progress: unitValue }
    | { readonly type: "error", readonly reason: string, readonly cause?: unknown }
    | { readonly type: "loaded" }