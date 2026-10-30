import {readdirSync, readFileSync} from "node:fs"
import {createRequire} from "node:module"
import {dirname, join} from "node:path"
import {isDefined, Optional, panic} from "@opendaw/lib-std"
import {formatRecord, runRequest, undoRequest} from "./Requests"
import {readScriptingFile} from "./Script"
import {RequestRecord, Workspace} from "./Workspace"

export type ToolResult = { text: string, ok: boolean }

export type Tool = {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    call(workspace: Workspace, args: Record<string, unknown>): Promise<ToolResult>
}

const MAX_DECLARATIONS = 10

type Documents = { guide: string, declarations: ReadonlyArray<string> }

let documents: Optional<Documents>

const readDocuments = (): Documents => {
    const scripting = dirname(dirname(createRequire(import.meta.url).resolve("@opendaw/studio-scripting/library")))
    const guide = readdirSync(join(scripting, "docs", "guide")).toSorted()
        .map(name => readFileSync(join(scripting, "docs", "guide", name), "utf8").replace(/^---\n[\s\S]*?\n---\n/, ""))
    return {guide: guide.join("\n"), declarations: readScriptingFile("api.declaration").split("\n\n")}
}

export const docs = (query: string): string => {
    const {guide, declarations} = documents ??= readDocuments()
    const wanted = query.trim().toLowerCase()
    if (wanted === "") {return guide}
    const found = declarations.filter(block => block.toLowerCase().includes(wanted))
    if (found.length === 0) {return `No Script API declaration mentions "${query}".`}
    const more = found.length > MAX_DECLARATIONS ? [`... and ${found.length - MAX_DECLARATIONS} more`] : []
    return [...found.slice(0, MAX_DECLARATIONS), ...more].join("\n\n")
}

const outcome = (request: RequestRecord): ToolResult =>
    ({text: formatRecord(request), ok: request.status === "applied" || request.status === "unchanged"})

export const run = async (workspace: Workspace, script: string, label: string): Promise<ToolResult> =>
    outcome(await runRequest(workspace, script, label))

export const undo = (workspace: Workspace): ToolResult =>
    undoRequest(workspace).match({none: () => ({text: "Nothing to undo.", ok: false}), some: outcome})

const stringArgument = (args: Record<string, unknown>, key: string): string => {
    const value = args[key]
    return typeof value === "string" ? value : panic(`The argument '${key}' must be a string`)
}

const objectSchema = (properties: Record<string, unknown>, required: ReadonlyArray<string>) =>
    ({type: "object", properties, required, additionalProperties: false})

export const TOOLS: ReadonlyArray<Tool> = [
    {
        name: "run",
        description: "Run an openDAW script on the project, as in the studio's script editor: read it with " +
            "'const project = await openDAW.getProject()', change it, and apply the changes with 'project.openInStudio()'. " +
            "The changes apply together as one request, which undo can take back. Type errors come back with line numbers " +
            "before the script runs, and console output comes back with the result.",
        inputSchema: objectSchema({
            script: {type: "string", description: "TypeScript, as in the studio's script editor"},
            label: {type: "string", description: "A short description of the change"}
        }, ["script", "label"]),
        call: async (workspace, args) => run(workspace, stringArgument(args, "script"), stringArgument(args, "label"))
    },
    {
        name: "undo",
        description: "Take back the newest applied request. Call it again to take back the one before.",
        inputSchema: objectSchema({}, []),
        call: async workspace => undo(workspace)
    },
    {
        name: "docs",
        description: "Without a query: the Script API guide. With a query: the Script API declarations that mention it, " +
            "for example 'Vaporisateur' or 'addRegion'.",
        inputSchema: objectSchema({query: {type: "string"}}, []),
        call: async (_workspace, args) => ({text: docs(isDefined(args.query) ? stringArgument(args, "query") : ""), ok: true})
    }
]
