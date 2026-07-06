// Fetch + compile the wasm modules the engine worklet needs: the engine (the dynamic-linker host) and
// the device PLUGINS (PIC side modules the engine loads at host-assigned bases). All are handed to the
// "engine" AudioWorkletProcessor via processorOptions; the worklet links the devices into the engine.

// A COMPOSITE device box (e.g. Playfield): a box that hosts a child collection of its own instruments rather
// than mapping to a single plugin. The engine learns it as data (registered like a device box type): the
// child collection's host field, and the child box field its order / routing reads. No engine code is
// composite-specific. The child plugin (e.g. PlayfieldSampleBox) is a normal entry in DEVICES.
export type CompositeSpec = {
    boxType: string, childrenField: number, indexKey: number, excludeKey: number,
    // When the composite hosts CELLS (a generic wrapper holding one instrument + its own chains), the cell box's
    // fixed field keys: the hosted instrument, its midi-fx host, its audio-fx host. All 0 = direct instruments.
    cellInstrumentField: number, cellMidiField: number, cellAudioField: number,
    // A child's `enabled` BooleanField (0 = no per-child enable). Playfield's slot key is 22, not the base device 4.
    childEnabledKey: number,
    // A child's `mute` / `solo` BooleanFields (0 = unsupported): a muted (or not-soloed while a sibling is
    // soloed) child gets no note STARTS (releases still pass), mirroring TS SampleProcessor.handleEvent.
    childMuteKey: number, childSoloKey: number
}

export type EngineModules = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module> // PIC side modules, in load order (device 0, 1, ...)
    deviceBoxTypes: ReadonlyArray<string> // parallel to deviceModules: the device-box type each plugin realizes
    composites: ReadonlyArray<CompositeSpec> // composite box types the engine should host as child collections
}

// The engine's single linear memory: SHARED, so the main thread can see the WASM heap (e.g. to write
// decoded sample data straight into it at an engine-allocated offset). wasm32 caps at 65536 pages (4 GiB),
// so that is the maximum; pages commit lazily on grow. Needs cross-origin isolation (COOP/COEP, set in
// vite.config). Created on the main thread and passed into the worklet via processorOptions.
export const createEngineMemory = (): WebAssembly.Memory =>
    new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})

// The device PIC side modules to load: each wasm plus the device-BOX TYPE it realizes. This is the device
// table the engine uses to instantiate a device box: when the box graph presents e.g. an ArpeggioDeviceBox,
// the engine looks up its type here to find its plugin under /wasm/plugins/. Load order is irrelevant now (the engine reads
// each unit's chains from the box, ordered by the device `index`); only the type mapping matters.
export const DEVICES: ReadonlyArray<{ url: string, boxType: string }> = [
    {url: "/wasm/plugins/device_vaporisateur.wasm", boxType: "VaporisateurDeviceBox"}, // instrument
    {url: "/wasm/plugins/device_nano.wasm", boxType: "NanoDeviceBox"},         // instrument (sampler)
    {url: "/wasm/plugins/device_revamp.wasm", boxType: "RevampDeviceBox"},     // audio effect
    {url: "/wasm/plugins/device_tidal.wasm", boxType: "TidalDeviceBox"},       // audio effect
    {url: "/wasm/plugins/device_delay.wasm", boxType: "DelayDeviceBox"},       // audio effect
    {url: "/wasm/plugins/device_gate.wasm", boxType: "GateDeviceBox"},         // audio effect (sidechain)
    {url: "/wasm/plugins/device_arpeggio.wasm", boxType: "ArpeggioDeviceBox"}, // midi effect
    {url: "/wasm/plugins/device_zeitgeist.wasm", boxType: "ZeitgeistDeviceBox"}, // midi effect
    {url: "/wasm/plugins/device_pitch.wasm", boxType: "PitchDeviceBox"},     // midi effect
    {url: "/wasm/plugins/device_werkstatt.wasm", boxType: "WerkstattDeviceBox"}, // scriptable audio effect
    {url: "/wasm/plugins/device_apparat.wasm", boxType: "ApparatDeviceBox"},   // scriptable instrument
    {url: "/wasm/plugins/device_spielwerk.wasm", boxType: "SpielwerkDeviceBox"}, // scriptable midi effect
    {url: "/wasm/plugins/device_waveshaper.wasm", boxType: "WaveshaperDeviceBox"}, // audio effect
    {url: "/wasm/plugins/device_crusher.wasm", boxType: "CrusherDeviceBox"},   // audio effect
    {url: "/wasm/plugins/device_fold.wasm", boxType: "FoldDeviceBox"},         // audio effect (wavefolder)
    {url: "/wasm/plugins/device_stereo_tool.wasm", boxType: "StereoToolDeviceBox"}, // audio effect
    {url: "/wasm/plugins/device_velocity.wasm", boxType: "VelocityDeviceBox"}, // midi effect
    {url: "/wasm/plugins/device_maximizer.wasm", boxType: "MaximizerDeviceBox"}, // audio effect
    {url: "/wasm/plugins/device_compressor.wasm", boxType: "CompressorDeviceBox"}, // audio effect (sidechain)
    {url: "/wasm/plugins/device_reverb.wasm", boxType: "ReverbDeviceBox"},     // audio effect
    {url: "/wasm/plugins/device_dattorro_reverb.wasm", boxType: "DattorroReverbDeviceBox"}, // audio effect
    {url: "/wasm/plugins/device_soundfont.wasm", boxType: "SoundfontDeviceBox"}, // instrument (preset sampler)
    {url: "/wasm/plugins/device_vocoder.wasm", boxType: "VocoderDeviceBox"},   // audio effect (channel vocoder + sidechain)
    {url: "/wasm/plugins/device_neural_amp.wasm", boxType: "NeuralAmpDeviceBox"}, // audio effect (NAM, via the nam bridge)
    {url: "/wasm/plugins/device_playfield_sample.wasm", boxType: "PlayfieldSampleBox"} // composite child (one Playfield slot)
]

// The composite box types. Playfield hosts its slots in the `samples` field (key 10); each slot's note is its
// `index` field (key 15) and its choke-group flag is `exclude` (key 42). The slot plugin itself is the
// PlayfieldSampleBox entry in DEVICES above.
export const COMPOSITES: ReadonlyArray<CompositeSpec> = [
    // Playfield: direct children (self-hosting slots, device-declared chains), routed by note index + choke.
    {boxType: "PlayfieldDeviceBox", childrenField: 10, indexKey: 15, excludeKey: 42,
        cellInstrumentField: 0, cellMidiField: 0, cellAudioField: 0, childEnabledKey: 22,
        childMuteKey: 40, childSoloKey: 41},
    // A generic instrument bundle: children are CELLS (CompositeCellBox) at field 10, each wrapping one
    // instrument (field 2) plus its midi-fx (3) and audio-fx (4) chains, ordered by the cell's own `index`
    // (field 5, UI position + engine sort). No note routing, no choke.
    {boxType: "CompositeDeviceBox", childrenField: 10, indexKey: 5, excludeKey: 0,
        cellInstrumentField: 2, cellMidiField: 3, cellAudioField: 4, childEnabledKey: 0,
        childMuteKey: 0, childSoloKey: 0}
]

export const loadEngineModules = async (base: string = ""): Promise<EngineModules> => {
    const urls = [`${base}/wasm/engine.wasm`, ...DEVICES.map(device => `${base}${device.url}`)]
    const buffers = await Promise.all(urls.map(url => fetch(url).then(response => response.ok
        ? response.arrayBuffer()
        : Promise.reject(new Error(`Could not load wasm module '${url}' (${response.status} ${response.statusText})`)))))
    const [engineModule, ...deviceModules] = await Promise.all(buffers.map(bytes => WebAssembly.compile(bytes)))
    return {engineModule, deviceModules, deviceBoxTypes: DEVICES.map(device => device.boxType), composites: COMPOSITES}
}
