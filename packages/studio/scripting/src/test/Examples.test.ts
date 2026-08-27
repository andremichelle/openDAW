import {describe, expect, it} from "vitest"
import {PPQN} from "@opendaw/lib-dsp"
import {readdirSync, readFileSync} from "node:fs"
import {resolve} from "node:path"
import {transformSync} from "esbuild"
import {ScriptGlobals} from "../ScriptRunner"
import {ApiImpl} from "../impl/ApiImpl"
import {FakeHost} from "./Fixture"

// Runs the studio's example scripts exactly like the code editor: imports stripped, compiled to JS, globals injected
const examplesDir = resolve(__dirname, "../../../../app/studio/src/ui/pages/code-editor/examples")
const truncateImports = (script: string) => script.substring(script.indexOf("//"))

const runWith = async (host: FakeHost, name: string): Promise<FakeHost> => {
    const api = new ApiImpl(host)
    const source = truncateImports(readFileSync(resolve(examplesDir, name), "utf-8"))
    const {code} = transformSync(source, {loader: "ts", format: "esm", target: "es2022"})
    const globals = ScriptGlobals.create(api, {sampleRate: 48000, baseFrequency: 440})
    const names = Object.keys(globals)
    const body = code.replace(/^export\s*\{\s*\};?/m, "")
    const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>
    await new AsyncFunction(...names, body)(...names.map(name => globals[name]))
    return host
}

const run = (name: string): Promise<FakeHost> => runWith(new FakeHost(), name)

describe("Example scripts", () => {
    readdirSync(examplesDir).filter(name => name.endsWith(".ts")).forEach(name => {
        it(`runs ${name}`, async () => {
            const host = await run(name)
            expect(host.opened.length + host.dialogs.length).toBe(1)
        })
    })

    it("cleans up the current project", async () => {
        const empty = await run("cleanup.ts")
        expect(empty.dialogs[0].message).toContain("No project")
        const host = new FakeHost()
        const api = new ApiImpl(host)
        const project = api.newProject("Messy")
        project.duration = PPQN.Bar * 8
        const synth = project.addInstrumentUnit("Vaporisateur", {label: "Synth"})
        const track = synth.noteTracks[0]
        track.addRegion({position: 0, duration: PPQN.Bar, label: "keep"})
        track.addRegion({position: PPQN.Bar, duration: PPQN.Bar, mute: true, label: "muted"})
        track.addRegion({position: PPQN.Bar * 8, duration: PPQN.Bar, label: "beyond"})
        track.addClip({mute: true})
        track.addClip({label: "keep"})
        synth.addNoteTrack()
        synth.addValueTrack(synth, "volume")
        const bare = project.addInstrumentUnit("Nano", {label: "Bare"})
        bare.addNoteTrack()
        const used = project.addAuxUnit({label: "Used"})
        project.addAuxUnit({label: "Unused"})
        synth.addSend(used)
        project.openInStudio()
        await runWith(host, "cleanup.ts")
        expect(host.dialogs[0].message).toContain("1 × muted regions")
        expect(host.dialogs[0].message).toContain("1 × muted clips")
        expect(host.dialogs[0].message).toContain("1 × regions beyond the project end")
        expect(host.dialogs[0].message).toContain("3 × empty tracks")
        expect(host.dialogs[0].message).toContain("1 × unused auxiliary units")
        expect(host.opened.length).toBe(1)
        expect(host.applied.length).toBe(1)
        const cleaned = await new ApiImpl(host).getProject()
        const cleanedSynth = cleaned.findAudioUnit("Synth")
        if (cleanedSynth?.kind !== "instrument") {throw new Error("synth missing")}
        expect(cleanedSynth.tracks.length).toBe(1)
        expect(cleanedSynth.noteTracks[0].regions.map(region => region.label)).toEqual(["keep"])
        expect(cleanedSynth.noteTracks[0].clips.map(clip => clip.label)).toEqual(["keep"])
        const cleanedBare = cleaned.findAudioUnit("Bare")
        expect(cleanedBare?.kind === "instrument" && cleanedBare.tracks.length).toBe(1)
        expect(cleaned.auxUnits.map(aux => aux.label)).toEqual(["Used"])
        await runWith(host, "cleanup.ts")
        expect(host.dialogs[1].message).toContain("already tidy")
        expect(host.applied.length).toBe(1)
    })

    it("counts the elements of the current project", async () => {
        const empty = await run("inventory.ts")
        expect(empty.dialogs[0].message).toContain("No project")
        const host = await run("acid.ts")
        const api = new ApiImpl(host)
        const source = truncateImports(readFileSync(resolve(examplesDir, "inventory.ts"), "utf-8"))
        const {code} = transformSync(source, {loader: "ts", format: "esm", target: "es2022"})
        const globals = ScriptGlobals.create(api, {sampleRate: 48000, baseFrequency: 440})
        const names = Object.keys(globals)
        const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>
        await new AsyncFunction(...names, code.replace(/^export\s*\{\s*\};?/m, ""))(...names.map(name => globals[name]))
        const {headline, message} = host.dialogs[0]
        expect(headline).toBe("Inventory")
        expect(message).toMatch(/^Acid \d+: 12\d bpm, 4\/4/)
        expect(message).toContain("2 × instrument units")
        expect(message).toContain("1 × output units")
        expect(message).toContain("16 × playfield slots")
        expect(message).toContain("5 × note clips")
        expect(message).toContain("64 × note regions")
        expect(message).toContain("5 × modulator Random")
        expect(message).toContain("5 × modulations")
        expect(message).toContain("64 × automation events")
        expect(message).toContain("1 × value tracks")
    })

    it("builds the acid arrangement", async () => {
        const host = await run("acid.ts")
        const api = new ApiImpl(host)
        const project = await api.getProject()
        expect(project.name).toMatch(/^Acid \d+$/)
        expect(project.loop.enabled).toBe(false)
        const drums = project.findAudioUnit("Drums")
        const line = project.findAudioUnit("Line")
        if (drums?.kind !== "instrument" || line?.kind !== "instrument") {throw new Error("units missing")}
        expect(drums.instrument.key === "Playfield" && drums.instrument.slots.length).toBe(16)
        expect(drums.noteTracks[0].clips.map(clip => clip.label)).toEqual(["Pattern A", "Pattern B", "Fill", "Drop", "Build"])
        expect(drums.noteTracks[0].regions.length).toBe(64)
        expect(drums.noteTracks[0].regions[0].events.length).toBeGreaterThan(0)
        expect(drums.noteTracks[0].regions[1].label).toBe("Fill")
        expect(line.instrument.key === "Cubed" && line.instrument.resonance).toBe(0.75)
        expect(line.instrument.key === "Cubed" && line.instrument.patterns[3].steps.some(step => step.active)).toBe(true)
        expect(project.modulators.map(modulator => modulator.label)).toEqual(["cutoff", "resonance", "envMod", "decay", "accent"])
        expect(project.modulators.every(modulator => modulator.kind === "Random" && modulator.modulations.length === 1)).toBe(true)
        expect(project.modulators[1].bipolar).toBe(true)
        expect(project.modulators[1].modulations[0].depth).toBe(0.75)
        expect(line.valueTracks[0].parameter).toBe("patternIndex")
        expect(line.valueTracks[0].regions[0].events.length).toBe(64)
    })
})
