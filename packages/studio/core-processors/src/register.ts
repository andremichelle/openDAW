// The worklet module the studio adds to every AudioContext (`AudioWorklets.createFor`). The ENGINE is NOT here:
// it is the wasm engine's own module ("engine-wasm-processor", registered by @opendaw/studio-core-wasm and
// added to the context by `WasmEngine.ensureReady`). What remains are the two engine-independent worklets the
// studio needs either way: meters and audio recording.
import {MeterProcessor} from "./MeterProcessor"
import {RecordingProcessor} from "./RecordingProcessor"

registerProcessor("meter-processor", MeterProcessor)
registerProcessor("recording-processor", RecordingProcessor)