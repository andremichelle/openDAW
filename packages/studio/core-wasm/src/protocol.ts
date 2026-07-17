import type {UUID} from "@opendaw/lib-std"
import type {CompositeSpec, EffectCompositeSpec} from "./engine-modules"

// The structured-clonable extras the wasm engine processor receives as `processorOptions.variant`.
export type WasmEngineAttachment = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module>
    deviceBoxTypes: ReadonlyArray<string>
    composites: ReadonlyArray<CompositeSpec>
    effectComposites: ReadonlyArray<EffectCompositeSpec>
    memory: WebAssembly.Memory
}

// main -> worklet: the SyncSource's transaction bytes (serialized on the main thread against the source
// graph's schema) for the engine's `apply_updates`, plus a checksum round-trip — the worklet compares the
// source graph's 32-byte checksum against the engine's rolling checksum (checksum_ptr) and rejects (after
// reporting through engineToClient.error) on divergence.
export interface WasmSyncProtocol {
    applyUpdates(bytes: ArrayBuffer): void
    checksum(bytes: Int8Array): Promise<void>
}

// main -> worklet: the freeze PCM delivery. The bulk copy happens on the MAIN thread (it owns the same
// shared WebAssembly.Memory): `frozenAllocate` is a small RPC returning the engine's planar stereo write
// pointer, the main thread writes the frames into shared memory, then `frozenAttach` re-wires the unit —
// the worklet side never copies sample data (a minutes-long freeze is 50-100 MB). `frozenClear` unfreezes.
export interface WasmFrozenProtocol {
    frozenAllocate(frameCount: number, channels: number): Promise<number>
    frozenAttach(uuid: UUID.Bytes, frameCount: number, channels: number, sampleRate: number): void
    frozenClear(uuid: UUID.Bytes): void
}

export const WASM_ENGINE_PROCESSOR_NAME = "engine-wasm-processor"
export const WASM_SYNC_CHANNEL = "engine-sync-bytes"
export const WASM_FROZEN_CHANNEL = "engine-frozen-audio"
