import {Nullable} from "@opendaw/lib-std"
import {ScriptEntryPoints} from "@opendaw/studio-adapters"
import {CodeEditorHandler} from "./CodeEditorHandler"
import {Workspace} from "@/ui/workspace/Workspace"
import {CommunityScriptTarget} from "@/opendaw-api/CommunityIndex"

export type CodeEditorState = Readonly<{
    handler: CodeEditorHandler
    initialCode: string
    previousScreen: Nullable<Workspace.ScreenKeys>
    communityTarget: CommunityScriptTarget
    starterPrompt: string
    entryPoints: ScriptEntryPoints.Api
}>
