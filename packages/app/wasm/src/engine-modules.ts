// Fetch + compile the two wasm modules the engine worklet needs: the engine itself and the sine
// instrument plugin (loaded as a separate module sharing the engine's memory). Both are handed to the
// "engine" AudioWorkletProcessor via processorOptions.

export type EngineModules = {
    engineModule: WebAssembly.Module
    instrumentModule: WebAssembly.Module
}

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
