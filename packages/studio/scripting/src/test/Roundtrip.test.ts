import {describe, expect, it} from "vitest"
import {PPQN} from "@opendaw/lib-dsp"
import {createFixture, sample} from "./Fixture"

describe("Roundtrip", () => {
    it("reads back a project opened in the studio and modifies it", async () => {
        const {api, project, host} = createFixture()
        project.bpm = 133
        project.timeSignature = {numerator: 3, denominator: 4}
        const synth = project.addInstrumentUnit("Vaporisateur", {label: "Lead", volume: -4}, {cutoff: 1234})
        const region = synth.noteTracks[0].addRegion({duration: PPQN.Bar, label: "Motif"})
        region.addEvents([{pitch: 60}, {pitch: 64, position: PPQN.Quarter}])
        const delay = synth.addAudioEffect("Delay", {feedback: 0.7})
        const aux = project.addAuxUnit({label: "FX"})
        synth.addSend(aux, {amount: -9})
        const tape = project.addInstrumentUnit("Tape")
        tape.audioTracks[0].addRegion(sample("Loop", 2, 120))
        const automation = synth.addValueTrack(delay, "feedback")
        automation.addRegion({duration: PPQN.Bar}).addEvent({value: 0.3})
        project.addMarker({position: PPQN.Bar, label: "Drop"})
        const lfo = project.addModulator("LFO")
        lfo.assign(synth.instrument, "cutoff", 0.4)
        project.openInStudio()
        expect(host.opened.length).toBe(1)

        const loaded = await api.getProject()
        expect(loaded.name).toBe("Test")
        expect(loaded.bpm).toBe(133)
        expect(loaded.timeSignature.numerator).toBe(3)
        expect(loaded.audioUnits.map(unit => unit.kind)).toEqual(["instrument", "instrument", "auxiliary", "output"])
        const lead = loaded.findAudioUnit("Lead")!
        expect(lead.kind).toBe("instrument")
        if (lead.kind !== "instrument") {return}
        expect(lead.volume).toBe(-4)
        expect(lead.instrument.key).toBe("Vaporisateur")
        expect(lead.instrument.key === "Vaporisateur" && lead.instrument.cutoff).toBe(1234)
        expect(lead.noteTracks[0].regions[0].label).toBe("Motif")
        expect(lead.noteTracks[0].regions[0].events.map(event => event.pitch)).toEqual([60, 64])
        expect(lead.audioEffects[0].key).toBe("Delay")
        expect(lead.audioEffects[0].key === "Delay" && lead.audioEffects[0].feedback).toBeCloseTo(0.7)
        expect(lead.sends[0].amount).toBe(-9)
        expect(lead.sends[0].target.label).toBe("FX")
        expect(lead.valueTracks[0].parameter).toBe("feedback")
        expect(lead.valueTracks[0].target).toBe(lead.audioEffects[0])
        expect(lead.valueTracks[0].regions[0].events[0].value).toBeCloseTo(0.3)
        const loadedTape = loaded.findAudioUnit("Tape")!
        expect(loadedTape.kind === "instrument" && loadedTape.audioTracks[0].regions[0].sample.name).toBe("Loop")
        expect(loadedTape.kind === "instrument" && loadedTape.audioTracks[0].regions[0].playback).toBe("pitch")
        expect(loaded.markers[0].label).toBe("Drop")
        expect(loaded.modulators[0].kind).toBe("LFO")
        expect(loaded.modulators[0].modulations[0].target).toBe(lead.instrument)
        expect(loaded.modulators[0].modulations[0].parameter).toBe("cutoff")
        lead.instrument.key === "Vaporisateur" && (lead.instrument.cutoff = 500)
        lead.noteTracks[0].regions[0].addEvent({pitch: 67})
        loaded.openInStudio()
        expect(host.opened.length).toBe(1)
        expect(host.applied.length).toBe(1)
        const reloaded = await api.getProject()
        const reloadedLead = reloaded.findAudioUnit("Lead")!
        expect(reloadedLead.kind === "instrument" && reloadedLead.noteTracks[0].regions[0].events.length).toBe(3)
        expect(reloadedLead.kind === "instrument" && reloadedLead.instrument.key === "Vaporisateur" && reloadedLead.instrument.cutoff).toBe(500)
    })

    it("replays edits as update batches and only sends the delta on a second apply", async () => {
        const {api, project, host} = createFixture()
        project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
        project.openInStudio()
        const loaded = await api.getProject()
        const lead = loaded.findAudioUnit("Lead")!
        if (lead.kind !== "instrument") {throw new Error("lead missing")}
        lead.volume = -12
        loaded.openInStudio()
        expect(host.applied.length).toBe(1)
        expect(host.applied[0].map(task => task.type)).toEqual(["update-primitive"])
        const removed = lead.addAudioEffect("Delay")
        removed.remove()
        const kept = lead.addAudioEffect("Reverb", {wet: -9})
        loaded.openInStudio()
        expect(host.applied.length).toBe(2)
        expect(host.applied[1].some(task => task.type === "new")).toBe(true)
        expect(host.applied[1].some(task => task.type === "delete")).toBe(true)
        const reloaded = await api.getProject()
        const reloadedLead = reloaded.findAudioUnit("Lead")!
        expect(reloadedLead.kind === "instrument" && reloadedLead.volume).toBe(-12)
        expect(reloadedLead.kind === "instrument" && reloadedLead.audioEffects.map(effect => effect.key)).toEqual(["Reverb"])
        expect(reloadedLead.kind === "instrument" && reloadedLead.audioEffects[0].uuid).toBe(kept.uuid)
        expect(host.opened.length).toBe(1)
    })

    it("refuses to replay onto a project that changed in the meantime", async () => {
        const {api, project, host} = createFixture()
        project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
        project.openInStudio()
        const loaded = await api.getProject()
        loaded.bpm = 90
        const other = await api.getProject()
        other.bpm = 100
        other.openInStudio()
        expect(() => loaded.openInStudio()).toThrow("Checksum mismatch")
    })

    it("lists and adds samples through the host", async () => {
        const {api, host} = createFixture()
        expect((await api.listSamples()).length).toBe(0)
        const {AudioData} = await import("@opendaw/lib-dsp")
        const data = AudioData.create(48000, 480, 1)
        const created = await api.addSample(data, "Blip")
        expect(created.name).toBe("Blip")
        expect(created.duration).toBeCloseTo(0.01)
        expect((await api.listSamples()).length).toBe(1)
        expect(host.samples[0]).toBe(created)
        await expect(api.addSample({} as any, "x")).rejects.toThrow(TypeError)
        await expect(api.addSample(AudioData.create(48000, 0, 1), "x")).rejects.toThrow(RangeError)
    })
})
