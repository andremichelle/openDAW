export {OPENDAW_SDK_VERSION} from "./version"

// Sample import, and the tempo detection it runs on the way in. `BpmDetector` is the seam every host
// implements or picks from: `Unknown` never guesses, `fromDuration` infers a tempo from the length alone,
// and `WasmBpmDetector` measures it. `SampleService` takes one as its second constructor argument, and a
// detector answering `None` stores bpm 0, the established "unknown" that leaves material unwarped.
// `Workers` must be installed first, since that is where `WasmBpmDetector` runs the analysis.
export {BpmDetector} from "@opendaw/studio-adapters"
export {SampleService, WasmBpmDetector, Workers} from "@opendaw/studio-core"

// Offline material analysis for imported audio: measured features (transient density, attack sharpness,
// tonality, grid regularity) plus a heuristic `drumLoopProbability` over them. Built to pick a stretch
// algorithm without asking the user, percussive material to `AudioTimeStretchBox`, sustained material to
// `AudioSignalsmithBox`, but it decides nothing itself. Runs in the same worker and on the same wasm
// module as `WasmBpmDetector`, so `Workers` must be installed first and the binary is compiled once.
// `AudioMaterial` exposes the aggregation constants and the probability formula for hosts that would
// rather weigh the raw features themselves.
export {AudioMaterial} from "@opendaw/lib-dsp"
export type {AudioMaterialFeatures, AudioMaterialSegment} from "@opendaw/lib-dsp"
export {AudioMaterialAnalyzer} from "@opendaw/studio-core"
