import SimpleSine from "./examples/simple-sine.js?raw"
import GrainSynth from "./examples/grain-synth.js?raw"
import TB303 from "./examples/tb-303.js?raw"
import {CodeEditorExample} from "@/ui/code-editor/CodeEditorState"

export const ApparatExamples: ReadonlyArray<CodeEditorExample> = [
    {name: "Simple Sine Synth", code: SimpleSine},
    {name: "Grain Synthesizer", code: GrainSynth},
    {name: "TB-303 Bass Line", code: TB303}
]
