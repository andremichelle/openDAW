import {unitValue} from "@opendaw/lib-std"

export type SampleLoaderState =
    | { readonly type: "idle" }
    | { readonly type: "record" }
    | { readonly type: "progress", progress: unitValue }
    | { readonly type: "error", readonly reason: string, readonly cause?: unknown }
    | { readonly type: "loaded" }