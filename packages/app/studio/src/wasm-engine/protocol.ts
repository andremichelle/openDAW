import type {CompositeSpec} from "../../../wasm/src/engine-modules"

// The structured-clonable extras the wasm engine processor receives as `processorOptions.variant`.
export type WasmEngineAttachment = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module>
    deviceBoxTypes: ReadonlyArray<string>
    composites: ReadonlyArray<CompositeSpec>
    memory: WebAssembly.Memory
}

// main -> worklet: the SyncSource's transaction bytes (serialized on the main thread against the source
// graph's schema) for the engine's `apply_updates`.
export interface WasmSyncProtocol {
    applyUpdates(bytes: ArrayBuffer): void
}

export const WASM_ENGINE_PROCESSOR_NAME = "engine-wasm-processor"
export const WASM_SYNC_CHANNEL = "engine-sync-bytes"
