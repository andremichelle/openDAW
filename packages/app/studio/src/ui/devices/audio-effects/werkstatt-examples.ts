import HardClipper from "./examples/hard-clipper.js?raw"
import RingModulator from "./examples/ring-modulator.js?raw"
import SimpleDelay from "./examples/simple-delay.js?raw"
import BiquadLowpass from "./examples/biquad-lowpass.js?raw"
import Alienator from "./examples/alienator.js?raw"
import Beautifier from "./examples/beautifier.js?raw"
import SidechainMixer from "./examples/sidechain-mixer.js?raw"
import SidechainDucker from "./examples/sidechain-ducker.js?raw"
import ParametricEq from "./examples/parametric-eq.js?raw"
import {CodeEditorExample} from "@/ui/code-editor/CodeEditorState"

export const WerkstattExamples: ReadonlyArray<CodeEditorExample> = [
    {name: "Hard Clipper", code: HardClipper},
    {name: "Ring Modulator", code: RingModulator},
    {name: "Simple Delay", code: SimpleDelay},
    {name: "Biquad Lowpass", code: BiquadLowpass},
    {name: "Alienator", code: Alienator},
    {name: "Beautifier", code: Beautifier},
    {name: "Sidechain Mixer", code: SidechainMixer},
    {name: "Sidechain Ducker", code: SidechainDucker},
    {name: "Parametric EQ", code: ParametricEq}
]
