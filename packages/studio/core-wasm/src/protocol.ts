import type {CompositeSpec, EffectCompositeSpec} from "./engine-modules"

// The structured-clonable extras the wasm engine processor receives as `processorOptions.variant`.
// The engine memory is NOT here: non-shared memories cannot be cloned, the processor creates its own.
export type WasmEngineAttachment = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module>
    deviceBoxTypes: ReadonlyArray<string>
    composites: ReadonlyArray<CompositeSpec>
    effectComposites: ReadonlyArray<EffectCompositeSpec>
}

// main -> worklet: the SyncSource's transaction bytes (serialized on the main thread against the source
// graph's schema) for the engine's `apply_updates`, plus a checksum round-trip — the worklet compares the
// source graph's 32-byte checksum against the engine's rolling checksum (checksum_ptr) and rejects (after
// reporting through engineToClient.error) on divergence.
export interface WasmSyncProtocol {
    applyUpdates(bytes: ArrayBuffer): void
    checksum(bytes: Int8Array): Promise<void>
}

export const WASM_ENGINE_PROCESSOR_NAME = "engine-wasm-processor"
export const WASM_SYNC_CHANNEL = "engine-sync-bytes"
