import {Nullable, Option} from "@opendaw/lib-std"
import {ScriptEntryPoints} from "@opendaw/studio-adapters"
import {CodeEditorHandler} from "./CodeEditorHandler"
import {Workspace} from "@/ui/workspace/Workspace"
import {CommunityScriptTarget} from "@/opendaw-api/CommunityIndex"
import {CompositeOverviewState} from "@/ui/composite-overview/CompositeOverviewState"

export type ScriptEditorState = Readonly<{
    type: "script"
    handler: CodeEditorHandler
    initialCode: string
    previousScreen: Nullable<Workspace.ScreenKeys>
    communityTarget: CommunityScriptTarget
    starterPrompt: string
    entryPoints: ScriptEntryPoints.Api
    returnTo: Option<CompositeOverviewState>
}>
