// The typed Communicator protocols for the worklet <-> main surface. Each protocol is ONE direction over its
// own named channel (a channel carries a single sender -> executor direction). The sample-load RPC lives in
// sample-loader.ts.

// main -> worklet: stream the SyncSource's serialized transaction bytes into the engine's box graph, and the
// transport controls. `play` starts the transport, `pause` freezes it (state kept), `stop` rewinds to 0 and
// resets every plugin + clears the buffers.
export interface EngineProtocol {
    applyUpdates(bytes: ArrayBuffer): void
    play(): void
    pause(): void
    stop(): void
    setMetronome(enabled: boolean): void
}

// worklet -> main: the ~30 Hz transport-state back-channel (position / bpm / playing), raw EngineState bytes.
export interface TransportListener {
    state(bytes: ArrayBuffer): void
}

// worklet -> main: the ~1 Hz heap-stats back-channel (observed by the metronome page).
export interface HeapListener {
    heap(stats: HeapStats): void
}

export interface HeapStats {
    heapUsed: number
    heapClaimed: number
    memoryTotal: number
}

// worklet -> main: a scriptable device (Werkstatt / Apparat / Spielwerk) reporting a runtime / validation error
// from its user script, so the app can surface it on the device (mirrors the TS engine's `deviceMessage`).
export interface ScriptListener {
    deviceMessage(uuid: string, message: string): void
}
