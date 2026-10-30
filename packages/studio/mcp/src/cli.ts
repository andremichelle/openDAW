import {readFileSync} from "node:fs"
import {basename} from "node:path"
import {parseArgs} from "node:util"
import {asDefined, isDefined, Optional, panic} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serveMcp} from "./Mcp"
import {messageOf} from "./Script"
import {docs, run, ToolResult, undo} from "./Tools"
import {copyBytes, Workspace} from "./Workspace"

const USAGE = `studio-mcp: edit an openDAW project with Script API scripts, from a shell or as an MCP server

  init [--from FILE.od]      create a workspace with an empty project, or with a copy of FILE.od
  run FILE.ts [--label L]    run a script (- reads it from stdin) and apply its changes as one request
  undo                       take back the newest applied request
  docs [QUERY]               the Script API guide, or the declarations that mention QUERY
  serve                      the same tools as an MCP server on stdio

The workspace is --dir DIR or the current directory. It holds project.od and requests/.`

const startingProject = (from: Optional<string>): ArrayBuffer => ProjectSkeleton.encode(isDefined(from)
    ? ProjectSkeleton.decode(copyBytes(readFileSync(from))).boxGraph
    : ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: true}).boxGraph) as ArrayBuffer

const main = async (): Promise<ToolResult> => {
    const {values, positionals: [command, ...rest]} = parseArgs({
        allowPositionals: true,
        options: {dir: {type: "string"}, from: {type: "string"}, label: {type: "string"}, help: {type: "boolean", short: "h"}}
    })
    const workspace = new Workspace(values.dir ?? ".")
    switch (values.help === true || !isDefined(command) ? "help" : command) {
        case "init":
            workspace.create(startingProject(values.from))
            return {text: `Created ${workspace.projectFile}`, ok: true}
        case "run": {
            const file = asDefined(rest[0], "run needs a script file, or - for stdin")
            const label = values.label ?? (file === "-" ? "request" : basename(file, ".ts"))
            return run(workspace, readFileSync(file === "-" ? 0 : file, "utf8"), label)
        }
        case "undo":
            return undo(workspace)
        case "docs":
            return {text: docs(rest.join(" ")), ok: true}
        case "serve":
            await serveMcp(workspace)
            return {text: "", ok: true}
        case "help":
            return {text: USAGE, ok: true}
        default:
            return panic(`Unknown command '${command}'. Run 'studio-mcp --help' for the commands.`)
    }
}

main().then(({text, ok}) => {
    if (text !== "") {process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)}
    process.exitCode = ok ? 0 : 1
}, (error: unknown) => {
    process.stderr.write(`studio-mcp: ${messageOf(error)}\n`)
    process.exitCode = 1
})
