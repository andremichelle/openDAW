import {ScriptEditorState} from "./ScriptEditorState"
import {CompositeOverviewState} from "@/ui/composite-overview/CompositeOverviewState"
import {MIDIMappingScreenState} from "@/ui/midi-mapping/MIDIMappingScreenState"

export type CodeEditorState = ScriptEditorState | CompositeOverviewState | MIDIMappingScreenState
