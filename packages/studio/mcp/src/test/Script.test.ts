import {describe, expect, it} from "vitest"
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ScriptHostProtocol} from "@opendaw/studio-scripting"
import {checkScript, runScript} from "../Script"
import {emptyProject} from "./Fixture"

const CONTEXT = {sampleRate: 48_000, baseFrequency: 440}

const host = (applied: Array<ReadonlyArray<UpdateTask<BoxIO.TypeMap>>>): ScriptHostProtocol => ({
    openProject: () => {},
    applyUpdates: updates => {applied.push(updates)},
    hasProject: async () => true,
    fetchProject: async () => ({buffer: emptyProject(), name: "Test"}),
    showInfo: async () => {},
    addSample: () => Promise.reject(new Error("no samples")),
    listSamples: async () => [],
    renderMixdown: () => Promise.reject(new Error("no render")),
    saveFile: async () => {}
})

describe("checkScript", () => {
    it("accepts a studio script with top-level await and return", () => {
        const script = "const project = await openDAW.getProject()\nif (project.bpm > 0) {return}\nproject.openInStudio()"
        expect(checkScript(script)).toEqual([])
    })

    it("reports type errors with their line and column", () => {
        const [diagnostic] = checkScript("const project = await openDAW.getProject()\nproject.bpm = \"fast\"")
        expect(diagnostic.line).toBe(2)
        expect(diagnostic.column).toBe(1)
        expect(diagnostic.message).toContain("not assignable to type 'number'")
    })
})

describe("runScript", () => {
    it("runs the script in a worker, with its console output and the edits it applies", async () => {
        const applied: Array<ReadonlyArray<UpdateTask<BoxIO.TypeMap>>> = []
        const result = await runScript(`const project = await openDAW.getProject()
project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
console.log("units", project.audioUnits.length)
project.openInStudio()`, host(applied), CONTEXT, 10_000)
        expect(result).toEqual({status: "done", output: ["units 2"]})
        expect(applied.length).toBe(1)
        expect(applied[0].some(task => task.type === "new")).true
    })

    it("reports an error the script throws", async () => {
        expect(await runScript("throw new Error(\"no tempo\")", host([]), CONTEXT, 10_000))
            .toEqual({status: "failed", message: "no tempo", output: []})
    })

    it("keeps the first thousand lines of output", async () => {
        const {output} = await runScript("for (let index = 0; index < 1500; index++) {console.log(index)}", host([]), CONTEXT, 10_000)
        expect(output.length).toBe(1001)
        expect(output.at(-1)).toBe("... and 500 more lines")
    })

    it("stops a script that does not finish", async () => {
        expect((await runScript("while (true) {}", host([]), CONTEXT, 500)).status).toBe("timeout")
    })
})
