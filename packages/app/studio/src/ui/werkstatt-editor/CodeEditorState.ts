import {Nullable} from "@opendaw/lib-std"
import {CodeEditorHandler} from "./CodeEditorHandler"
import {Workspace} from "@/ui/workspace/Workspace"

export type CodeEditorState = Readonly<{
    handler: CodeEditorHandler
    initialCode: string
    previousScreen: Nullable<Workspace.ScreenKeys>
}>
