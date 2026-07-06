import {Func, Nullable, Option, Provider, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Messenger} from "@opendaw/lib-runtime"
import type {Project} from "./project"

// A main-thread replacement for the `EngineCommands.setFrozenAudio` transfer (null = unfreeze).
export type FrozenAudioWriter = (uuid: UUID.Bytes, audioData: Nullable<AudioData>) => void

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
    // Optional: routes `setFrozenAudio` around the generic command transfer so the variant can deliver the
    // freeze PCM itself (the wasm engine writes it into its shared memory from the MAIN thread — bulk
    // copying inside the worklet's message handler would stall the audio thread).
    readonly connectFrozenAudio?: Func<Messenger, FrozenAudioWriter>
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
