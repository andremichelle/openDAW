import {Nullable} from "@opendaw/lib-std"
import {Workspace} from "@/ui/workspace/Workspace"

export type MIDIMappingScreenState = Readonly<{
    type: "midi-mapping"
    previousScreen: Nullable<Workspace.ScreenKeys>
}>
