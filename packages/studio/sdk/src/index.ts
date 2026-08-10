export {OPENDAW_SDK_VERSION} from "./version"

// Sample import, and the tempo detection it runs on the way in. `BpmDetector` is the seam every host
// implements or picks from: `Unknown` never guesses, `fromDuration` infers a tempo from the length alone,
// and `WasmBpmDetector` measures it. `SampleService` takes one as its second constructor argument, and a
// detector answering `None` stores bpm 0, the established "unknown" that leaves material unwarped.
// `Workers` must be installed first, since that is where `WasmBpmDetector` runs the analysis.
export {BpmDetector} from "@opendaw/studio-adapters"
export {SampleService, WasmBpmDetector, Workers} from "@opendaw/studio-core"
