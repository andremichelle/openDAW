import {spawnSync} from "node:child_process"
import {writeFileSync} from "node:fs"
import {join} from "node:path"
import {fileURLToPath} from "node:url"
import {describe, expect, it} from "vitest"
import {temporaryDirectory} from "./Fixture"

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url))

const studioMcp = (args: ReadonlyArray<string>, input?: string) =>
    spawnSync(process.execPath, [cli, ...args], {encoding: "utf8", input, timeout: 20_000})

describe("command line", {timeout: 30_000}, () => {
    it("creates a workspace, runs a script and takes it back", () => {
        const directory = temporaryDirectory()
        expect(studioMcp(["init", "--dir", directory]).stdout).toContain("project.od")
        writeFileSync(join(directory, "tempo.ts"), "const project = await openDAW.getProject()\nproject.bpm = 90\nproject.openInStudio()")
        const run = studioMcp(["run", join(directory, "tempo.ts"), "--dir", directory])
        expect(run.status).toBe(0)
        expect(run.stdout).toMatch(/^tempo \(\w+\): applied\n$/)
        expect(studioMcp(["undo", "--dir", directory]).stdout).toContain("Undo tempo")
        const empty = studioMcp(["undo", "--dir", directory])
        expect(empty.status).toBe(1)
        expect(empty.stdout).toBe("Nothing to undo.\n")
    })

    it("writes only JSON-RPC to stdout when it serves MCP", () => {
        const directory = temporaryDirectory()
        studioMcp(["init", "--dir", directory])
        const script = "const raw = globalThis as any\nraw.process.stdout.write(\"raw\\n\")\nconsole.log(\"logged\")"
        const served = studioMcp(["serve", "--dir", directory], [
            {jsonrpc: "2.0", id: 1, method: "initialize", params: {}},
            {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "run", arguments: {script, label: "Print"}}}
        ].map(message => JSON.stringify(message)).join("\n") + "\n")
        const lines = served.stdout.split("\n").filter(line => line !== "")
        expect(lines.length).toBe(2)
        expect(JSON.parse(lines[1]).result.content[0].text).toContain("logged")
    })

    it("prints the usage", () => {
        const help = studioMcp(["--help"])
        expect(help.status).toBe(0)
        expect(help.stdout).toContain("studio-mcp: edit an openDAW project")
    })

    it("refuses an unknown command", () => {
        const unknown = studioMcp(["play"])
        expect(unknown.status).toBe(1)
        expect(unknown.stderr).toBe("studio-mcp: Unknown command 'play'. Run 'studio-mcp --help' for the commands.\n")
    })
})
