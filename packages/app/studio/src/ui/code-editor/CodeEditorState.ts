import {Nullable} from "@opendaw/lib-std"
import {CodeEditorHandler} from "./CodeEditorHandler"
import {Workspace} from "@/ui/workspace/Workspace"

export type CodeEditorExample = Readonly<{
    name: string
    code: string
}>

export type CodeEditorState = Readonly<{
    handler: CodeEditorHandler
    initialCode: string
    previousScreen: Nullable<Workspace.ScreenKeys>
    examples: ReadonlyArray<CodeEditorExample>
    starterPrompt: string
}>
