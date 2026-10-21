import SimpleSine from "./examples/simple-sine.js?raw"
import GrainSynth from "./examples/grain-synth.js?raw"
import TB303 from "./examples/tb-303.js?raw"
import Deminix from "./examples/deminix.js?raw"
import SidechainGate from "./examples/sidechain-gate.js?raw"
import EnvelopeView from "./examples/envelope-view.js?raw"
import {CodeEditorExample} from "@/ui/code-editor/CodeEditorState"

export const ApparatExamples: ReadonlyArray<CodeEditorExample> = [
    {name: "Simple Sine Synth", code: SimpleSine},
    {name: "Grain Synthesizer", code: GrainSynth},
    {name: "TB-303 Bass Line", code: TB303},
    {name: "Deminix Random Synth", code: Deminix},
    {name: "Sidechain Gated Sine", code: SidechainGate},
    {name: "Envelope Synth (View)", code: EnvelopeView}
]
