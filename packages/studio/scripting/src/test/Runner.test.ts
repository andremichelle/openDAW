import {describe, expect, it} from "vitest"
import {ScriptRunner} from "../ScriptRunner"
import {FakeHost} from "./Fixture"
import {ScriptResult} from "../ScriptResult"

// The runner executes emitted JS as a function body, exactly what the code editor hands over
const context = {sampleRate: 48000, baseFrequency: 440}

describe("ScriptRunner", () => {
    it("allows a top-level return", async () => {
        const host = new FakeHost()
        await new ScriptRunner(host).run(`
            if (!await openDAW.hasProject()) {
                await openDAW.showInfo("Edit", "No project");
                return;
            }
            await openDAW.showInfo("Edit", "Unreachable");
            export {};`, context)
        expect(host.dialogs).toEqual([{headline: "Edit", message: "No project"}])
    })

    it("strips the module marker and runs a create script", async () => {
        const host = new FakeHost()
        await new ScriptRunner(host).run(`
            const project = openDAW.newProject("Runner");
            project.bpm = 99;
            project.openInStudio();
            export {};`, context)
        expect(host.opened).toHaveLength(1)
    })

    it("exposes the context as globals", async () => {
        const host = new FakeHost()
        await new ScriptRunner(host).run(`await openDAW.showInfo("Rate", String(sampleRate));`, context)
        expect(host.dialogs[0].message).toBe("48000")
    })

    it("evaluates to the script's return value", async () => {
        const runner = new ScriptRunner(new FakeHost())
        expect(await runner.evaluate(`return {bpm: openDAW.newProject("A").bpm}`, context)).toEqual({bpm: 120})
        expect(await runner.evaluate(`const x = 1`, context)).toBeUndefined()
    })

    it("turns results into text", () => {
        expect(ScriptResult.toText(undefined)).toBeNull()
        expect(ScriptResult.toText(null)).toBeNull()
        expect(ScriptResult.toText("plain")).toBe("plain")
        expect(ScriptResult.toText(3)).toBe("3")
        expect(ScriptResult.toText([1, {a: true}])).toBe(JSON.stringify([1, {a: true}], null, 2))
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        expect(ScriptResult.toText(cyclic)).toBe("[object Object]")
        expect(ScriptResult.toText(10n)).toBe("10")
    })

    it("rejects with the script error", async () => {
        const host = new FakeHost()
        await expect(new ScriptRunner(host).run(`throw new Error("boom")`, context)).rejects.toThrow("boom")
    })
})
