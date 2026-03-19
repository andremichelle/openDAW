import SimpleSine from "./examples/simple-sine.js?raw"
import GrainSynth from "./examples/grain-synth.js?raw"
import {CodeEditorExample} from "@/ui/werkstatt-editor/CodeEditorState"

export const ApparatExamples: ReadonlyArray<CodeEditorExample> = [
    {name: "Simple Sine Synth", code: SimpleSine},
    {name: "Grain Synthesizer", code: GrainSynth}
]
