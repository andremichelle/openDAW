import {describe, expect, it} from "vitest"
import {ByteArrayInput, Option} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {PPQN} from "@opendaw/lib-dsp"
import {BoxIO} from "@opendaw/studio-boxes"
import {PresetHeader} from "@opendaw/studio-adapters"
import {createFixture, sample} from "./Fixture"

const boxNamesOf = (bytes: ArrayBuffer): ReadonlyArray<string> => {
    const header = new ByteArrayInput(bytes.slice(0, 8))
    expect(header.readInt()).toBe(PresetHeader.MAGIC_HEADER_OPEN)
    expect(header.readInt()).toBe(PresetHeader.FORMAT_VERSION)
    const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    graph.fromArrayBuffer(bytes.slice(8), false)
    return graph.boxes().map(box => box.name)
}

describe("encodePreset", () => {
    it("holds the instrument only by default", () => {
        const {project} = createFixture()
        const synth = project.addInstrumentUnit("Vaporisateur", {label: "Lead"}, {cutoff: 1234})
        synth.addAudioEffect("Delay")
        synth.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvents([{pitch: 60}])
        const names = boxNamesOf(synth.encodePreset())
        expect(names).toContain("VaporisateurDeviceBox")
        expect(names).not.toContain("DelayDeviceBox")
        expect(names).not.toContain("NoteRegionBox")
    })
    it("keeps effects and timeline on request", () => {
        const {project} = createFixture()
        const synth = project.addInstrumentUnit("Vaporisateur")
        synth.addAudioEffect("Delay")
        synth.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvents([{pitch: 60}])
        const names = boxNamesOf(synth.encodePreset({effects: true, timeline: true}))
        expect(names).toContain("DelayDeviceBox")
        expect(names).toContain("NoteRegionBox")
    })
    it("carries the samples of a Sampler", () => {
        const {project} = createFixture()
        const sampler = project.addInstrumentUnit("Sampler").instrument
        sampler.addZone(sample("Vibes_C3", 1, 0), {rootKey: 48, keyLow: 47, keyHigh: 50})
        sampler.addZone(sample("Vibes_E3", 1, 0), {rootKey: 52, keyLow: 51, keyHigh: 53})
        const names = boxNamesOf(project.instrumentUnits[0].encodePreset())
        expect(names.filter(name => name === "SamplerZoneBox").length).toBe(2)
        expect(names.filter(name => name === "AudioFileBox").length).toBe(2)
    })
    it("rejects options of the wrong type", () => {
        const {project} = createFixture()
        const synth = project.addInstrumentUnit("Vaporisateur")
        expect(() => synth.encodePreset({effects: "yes" as unknown as boolean})).toThrow()
    })
})
