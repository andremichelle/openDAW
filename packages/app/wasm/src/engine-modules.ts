// Fetch + compile the two wasm modules the engine worklet needs: the engine itself and the sine
// instrument plugin (loaded as a separate module sharing the engine's memory). Both are handed to the
// "engine" AudioWorkletProcessor via processorOptions.

export type EngineModules = {
    engineModule: WebAssembly.Module
    instrumentModule: WebAssembly.Module
}

// The engine's single linear memory: SHARED, so the main thread can see the WASM heap (e.g. to write
// decoded sample data straight into it at an engine-allocated offset). wasm32 caps at 65536 pages (4 GiB),
// so that is the maximum; pages commit lazily on grow. Needs cross-origin isolation (COOP/COEP, set in
// vite.config). Created on the main thread and passed into the worklet via processorOptions.
export const createEngineMemory = (): WebAssembly.Memory =>
    new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})

export const loadEngineModules = async (): Promise<EngineModules> => {
    const [engineBytes, instrumentBytes] = await Promise.all([
        fetch("/engine.wasm").then(response => response.arrayBuffer()),
        fetch("/device_sine.wasm").then(response => response.arrayBuffer())
    ])
    const [engineModule, instrumentModule] = await Promise.all([
        WebAssembly.compile(engineBytes),
        WebAssembly.compile(instrumentBytes)
    ])
    return {engineModule, instrumentModule}
}
