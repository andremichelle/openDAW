import {Nullable, Option, Provider, Terminable} from "@opendaw/lib-std"
import {Messenger} from "@opendaw/lib-runtime"
import type {Project} from "./project"

// An alternative engine AudioWorkletProcessor (e.g. the WASM engine). It must speak the exact same message
// contract as "engine-processor" (engine-commands, engine-to-client, EngineState SyncStream, engine-live-data,
// engine-preferences); only the box-graph synchronization is variant-specific, provided via `connectSync`.
export type EngineWorkletVariant = {
    // The registered processor name to instantiate instead of "engine-processor".
    readonly processorName: string
    // Structured-clonable extras handed to the processor as `processorOptions.variant`.
    readonly attachment: Record<string, unknown>
    // Replaces the default `SyncSource` on the "engine-sync" channel with the variant's own sync wiring.
    readonly connectSync: (messenger: Messenger, project: Project) => Terminable
}

export class EngineVariant {
    static install(provider: Provider<Nullable<EngineWorkletVariant>>): void {
        this.#provider = Option.wrap(provider)
    }

    // The variant to boot the NEXT EngineWorklet with, resolved at construction time so an engine restart
    // always honors the current selection. Null selects the built-in TS engine.
    static current(): Nullable<EngineWorkletVariant> {
        return this.#provider.mapOr(provider => provider(), null)
    }

    static #provider: Option<Provider<Nullable<EngineWorkletVariant>>> = Option.None
}
