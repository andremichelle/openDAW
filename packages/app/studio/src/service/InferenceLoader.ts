import {isNull, Nullable, Option} from "@opendaw/lib-std"
import type * as InferenceLib from "@opendaw/lib-inference"
import {Workers} from "@opendaw/studio-core"

type InferenceModule = typeof InferenceLib

// A host that installs the inference runtime and models itself (the desktop app's optional Neural Demux component)
export interface InferenceHost {
    // resolves once runtime and models are there; rejects (AbortError) when the user declines or is offline
    ensureAvailable(inference: typeof InferenceLib.Inference): Promise<void>
    modelSource(taskKey: string, model: InferenceLib.ModelDescriptor): Promise<Option<Uint8Array>>
    modelHosted(taskKey: string, model: InferenceLib.ModelDescriptor): Promise<boolean>
}

let cached: Nullable<InferenceModule> = null
let host: Option<InferenceHost> = Option.None

export const installInferenceHost = (installed: InferenceHost): void => {host = Option.wrap(installed)}

/**
 * Lazy-load `@opendaw/lib-inference` and install it (once) on first use.
 * Keeps the lib-inference chunk out of the studio's boot bundle. Safe to
 * call from any feature that needs to run an inference task.
 */
export const ensureInference = async (): Promise<typeof InferenceLib.Inference> => {
    if (isNull(cached)) {
        cached = await import("@opendaw/lib-inference")
        cached.Inference.install(host.match({
            none: () => ({opfs: Workers.Opfs}),
            some: ({modelSource, modelHosted}) => ({opfs: Workers.Opfs, modelSource, modelHosted})
        }))
    }
    const {Inference} = cached
    await host.mapOr(installed => installed.ensureAvailable(Inference), Promise.resolve())
    return Inference
}
