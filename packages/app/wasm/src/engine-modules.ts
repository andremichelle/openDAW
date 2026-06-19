// Fetch + compile the wasm modules the engine worklet needs: the engine (the dynamic-linker host) and
// the device PLUGINS (PIC side modules the engine loads at host-assigned bases). All are handed to the
// "engine" AudioWorkletProcessor via processorOptions; the worklet links the devices into the engine.

export type EngineModules = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module> // PIC side modules, in load order (device 0, 1, ...)
}

// The engine's single linear memory: SHARED, so the main thread can see the WASM heap (e.g. to write
// decoded sample data straight into it at an engine-allocated offset). wasm32 caps at 65536 pages (4 GiB),
// so that is the maximum; pages commit lazily on grow. Needs cross-origin isolation (COOP/COEP, set in
// vite.config). Created on the main thread and passed into the worklet via processorOptions.
export const createEngineMemory = (): WebAssembly.Memory =>
    new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})

// The device PIC side modules to load, in order. Round-robin-assigned to audio units by the engine until
// the per-unit instrument device is read from the box graph, so the order picks which unit gets which.
// MIDI fx load order matters: they are folded onto the lead's pull chain in this order, so the LAST one
// (transpose) is closest to the instrument -> sequencer <- arp <- transpose <- instrument.
const DEVICE_URLS = ["/device_sine.wasm", "/device_saw.wasm", "/device_lowpass.wasm", "/device_arp.wasm", "/device_transpose.wasm"] as const

export const loadEngineModules = async (): Promise<EngineModules> => {
    const urls = ["/engine.wasm", ...DEVICE_URLS]
    const buffers = await Promise.all(urls.map(url => fetch(url).then(response => response.arrayBuffer())))
    const [engineModule, ...deviceModules] = await Promise.all(buffers.map(bytes => WebAssembly.compile(bytes)))
    return {engineModule, deviceModules}
}
