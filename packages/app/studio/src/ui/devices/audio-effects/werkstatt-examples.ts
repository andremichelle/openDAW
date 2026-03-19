import HardClipper from "./examples/hard-clipper.js?raw"
import RingModulator from "./examples/ring-modulator.js?raw"
import SimpleDelay from "./examples/simple-delay.js?raw"
import BiquadLowpass from "./examples/biquad-lowpass.js?raw"
import {CodeEditorExample} from "@/ui/werkstatt-editor/CodeEditorState"

export const WerkstattExamples: ReadonlyArray<CodeEditorExample> = [
    {name: "Hard Clipper", code: HardClipper},
    {name: "Ring Modulator", code: RingModulator},
    {name: "Simple Delay", code: SimpleDelay},
    {name: "Biquad Lowpass", code: BiquadLowpass}
]
