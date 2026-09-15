import {describe, expect, it} from "vitest"
import {PPQN, WavFile} from "@opendaw/lib-dsp"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {ScriptRunner} from "../ScriptRunner"
import {createFixture, FakeHost} from "./Fixture"

const context = {sampleRate: 48000, baseFrequency: 440}

describe("Project.mixdown", () => {
    it("rejects an empty project before reaching the host", async () => {
        const {project, host} = createFixture()
        await expect(project.mixdown()).rejects.toThrow(RangeError)
        expect(host.rendered).toHaveLength(0)
    })

    it("sends the script's graph with its edits applied", async () => {
        const {project, host} = createFixture()
        project.bpm = 133
        const synth = project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
        synth.noteTracks[0].addRegion({position: 0, duration: PPQN.Bar})
        const audio = await project.mixdown()
        expect(host.rendered).toHaveLength(1)
        expect(host.rendered[0].options).toEqual({sampleRate: 48000})
        expect(host.opened).toHaveLength(0)
        const {mandatoryBoxes: {timelineBox}} = ProjectSkeleton.decode(host.rendered[0].buffer as ArrayBuffer)
        expect(timelineBox.bpm.getValue()).toBe(133)
        expect(audio.sampleRate).toBe(48000)
        expect(audio.numberOfChannels).toBe(2)
    })

    it("forwards and clamps the sample rate", async () => {
        const {project, host} = createFixture()
        project.addInstrumentUnit("Vaporisateur").noteTracks[0].addRegion({position: 0, duration: PPQN.Bar})
        await project.mixdown({sampleRate: 44100})
        expect(host.rendered[0].options.sampleRate).toBe(44100)
        await project.mixdown({sampleRate: 1})
        expect(host.rendered[1].options.sampleRate).toBe(8000)
        await expect(project.mixdown({sampleRate: NaN})).rejects.toThrow(TypeError)
    })

    it("also works on a fetched studio project", async () => {
        const {project, host, api} = createFixture()
        project.addInstrumentUnit("Vaporisateur").noteTracks[0].addRegion({position: 0, duration: PPQN.Bar})
        project.openInStudio()
        const fetched = await api.getProject()
        fetched.bpm = 77
        await fetched.mixdown()
        expect(host.applied).toHaveLength(0)
        const {mandatoryBoxes} = ProjectSkeleton.decode(host.rendered[0].buffer as ArrayBuffer)
        expect(mandatoryBoxes.timelineBox.bpm.getValue()).toBe(77)
    })
})

describe("openDAW.saveFile", () => {
    it("passes an ArrayBuffer through with a default mime type", async () => {
        const {api, host} = createFixture()
        await api.saveFile(new ArrayBuffer(16), "notes.bin")
        expect(host.saved).toEqual([{byteLength: 16, fileName: "notes.bin", mimeType: "application/octet-stream"}])
    })

    it("slices a typed array to its own buffer", async () => {
        const {api, host} = createFixture()
        const backing = new Uint8Array(32)
        await api.saveFile(new Uint8Array(backing.buffer, 8, 4), "part.bin", "audio/wav")
        expect(host.saved[0]).toEqual({byteLength: 4, fileName: "part.bin", mimeType: "audio/wav"})
    })

    it("guards the arguments", async () => {
        const {api, host} = createFixture()
        await expect(api.saveFile("text" as unknown as ArrayBuffer, "a.txt")).rejects.toThrow(TypeError)
        await expect(api.saveFile(new ArrayBuffer(1), "")).rejects.toThrow(RangeError)
        await expect(api.saveFile(new ArrayBuffer(1), "   ")).rejects.toThrow(RangeError)
        await expect(api.saveFile(new ArrayBuffer(1), "dir/a.txt")).rejects.toThrow(RangeError)
        await expect(api.saveFile(new ArrayBuffer(1), "dir\\a.txt")).rejects.toThrow(RangeError)
        await expect(api.saveFile(new ArrayBuffer(1), 3 as unknown as string)).rejects.toThrow(TypeError)
        await expect(api.saveFile(new ArrayBuffer(1), "a.txt", 3 as unknown as string)).rejects.toThrow(TypeError)
        expect(host.saved).toHaveLength(0)
    })

    it("runs the documented mixdown script end to end", async () => {
        const host = new FakeHost()
        await new ScriptRunner(host).run(`
            const project = openDAW.newProject("Render")
            const synth = project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
            synth.noteTracks[0].addRegion({position: 0, duration: PPQN.Bar})
            const audio = await project.mixdown()
            await openDAW.saveFile(WavFile.encodeFloats(audio), project.name + ".wav", "audio/wav")`, context)
        expect(host.rendered).toHaveLength(1)
        expect(host.saved).toHaveLength(1)
        expect(host.saved[0].fileName).toBe("Render.wav")
        expect(host.saved[0].mimeType).toBe("audio/wav")
        expect(host.saved[0].byteLength).toBe(WavFile.encodeFloats(await host.renderMixdown(new ArrayBuffer(0), {})).byteLength)
    })
})
