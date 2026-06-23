// Fetch + compile the wasm modules the engine worklet needs: the engine (the dynamic-linker host) and
// the device PLUGINS (PIC side modules the engine loads at host-assigned bases). All are handed to the
// "engine" AudioWorkletProcessor via processorOptions; the worklet links the devices into the engine.

export type EngineModules = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module> // PIC side modules, in load order (device 0, 1, ...)
    deviceBoxTypes: ReadonlyArray<string> // parallel to deviceModules: the device-box type each plugin realizes
}

// The engine's single linear memory: SHARED, so the main thread can see the WASM heap (e.g. to write
// decoded sample data straight into it at an engine-allocated offset). wasm32 caps at 65536 pages (4 GiB),
// so that is the maximum; pages commit lazily on grow. Needs cross-origin isolation (COOP/COEP, set in
// vite.config). Created on the main thread and passed into the worklet via processorOptions.
export const createEngineMemory = (): WebAssembly.Memory =>
    new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})

// The device PIC side modules to load: each wasm plus the device-BOX TYPE it realizes. This is the device
// table the engine uses to instantiate a device box: when the box graph presents e.g. an ArpeggioDeviceBox,
// the engine looks up its type here to find device_arp.wasm. Load order is irrelevant now (the engine reads
// each unit's chains from the box, ordered by the device `index`); only the type mapping matters.
const DEVICES: ReadonlyArray<{ url: string, boxType: string }> = [
    {url: "/device_sine.wasm", boxType: "VaporisateurDeviceBox"}, // instrument
    {url: "/device_saw.wasm", boxType: "NanoDeviceBox"},          // instrument
    {url: "/device_lowpass.wasm", boxType: "RevampDeviceBox"},    // audio effect
    {url: "/device_tidal.wasm", boxType: "TidalDeviceBox"},       // audio effect
    {url: "/device_arp.wasm", boxType: "ArpeggioDeviceBox"},      // midi effect
    {url: "/device_zeitgeist.wasm", boxType: "ZeitgeistDeviceBox"}, // midi effect
    {url: "/device_transpose.wasm", boxType: "PitchDeviceBox"}    // midi effect
]

export const loadEngineModules = async (): Promise<EngineModules> => {
    const urls = ["/engine.wasm", ...DEVICES.map(device => device.url)]
    const buffers = await Promise.all(urls.map(url => fetch(url).then(response => response.arrayBuffer())))
    const [engineModule, ...deviceModules] = await Promise.all(buffers.map(bytes => WebAssembly.compile(bytes)))
    return {engineModule, deviceModules, deviceBoxTypes: DEVICES.map(device => device.boxType)}
}
