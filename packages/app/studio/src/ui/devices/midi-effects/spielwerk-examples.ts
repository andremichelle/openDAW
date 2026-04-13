import ChordGenerator from "./examples/chord-generator.js?raw"
import Velocity from "./examples/velocity.js?raw"
import Pitch from "./examples/pitch.js?raw"
import RandomHumanizer from "./examples/random-humanizer.js?raw"
import ProbabilityGate from "./examples/probability-gate.js?raw"
import EchoNoteDelay from "./examples/echo-note-delay.js?raw"
import PitchRangeFilter from "./examples/pitch-range-filter.js?raw"
import TB303Sequencer from "./examples/tb-303-sequencer.js?raw"
import {CodeEditorExample} from "@/ui/code-editor/CodeEditorState"

export const SpielwerkExamples: ReadonlyArray<CodeEditorExample> = [
    {name: "Chord Generator", code: ChordGenerator},
    {name: "Velocity", code: Velocity},
    {name: "Pitch", code: Pitch},
    {name: "Random Humanizer", code: RandomHumanizer},
    {name: "Probability Gate", code: ProbabilityGate},
    {name: "Echo / Note Delay", code: EchoNoteDelay},
    {name: "Pitch Range Filter", code: PitchRangeFilter},
    {name: "303 Sequencer", code: TB303Sequencer}
]
