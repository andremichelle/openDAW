// The worklet module the studio adds to every AudioContext (`AudioWorklets.createFor`). The ENGINE is NOT here:
// it is the wasm engine's own module ("engine-wasm-processor", registered by @opendaw/studio-core-wasm and
// added to the context by `WasmEngine.ensureReady`). What remains are the three engine-independent worklets the
// studio needs either way: meters, audio recording and the input-latency calibration capture.
import {MeterProcessor} from "./MeterProcessor"
import {RecordingProcessor} from "./RecordingProcessor"
import {LatencyCaptureProcessor} from "./LatencyCaptureProcessor"

registerProcessor("meter-processor", MeterProcessor)
registerProcessor("recording-processor", RecordingProcessor)
registerProcessor("latency-capture-processor", LatencyCaptureProcessor)