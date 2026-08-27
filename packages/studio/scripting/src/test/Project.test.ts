import {describe, expect, it} from "vitest"
import {Interpolation, PPQN} from "@opendaw/lib-dsp"
import {createFixture} from "./Fixture"

describe("Project", () => {
    it("creates an empty project with an output unit", () => {
        const {project} = createFixture()
        expect(project.name).toBe("Test")
        expect(project.output.kind).toBe("output")
        expect(project.audioUnits.length).toBe(1)
        expect(project.audioUnits[0]).toBe(project.output)
        expect(project.output.label).toBe("Output")
        expect(project.bpm).toBe(120)
        expect(project.timeSignature.numerator).toBe(4)
        expect(project.timeSignature.denominator).toBe(4)
        expect(project.baseFrequency).toBe(440)
    })

    it("validates and clamps global settings", () => {
        const {project} = createFixture()
        project.bpm = 140
        expect(project.bpm).toBe(140)
        project.bpm = 5
        expect(project.bpm).toBe(30)
        project.bpm = 5000
        expect(project.bpm).toBe(999)
        expect(() => {project.bpm = NaN}).toThrow(TypeError)
        expect(() => {(project as any).bpm = "fast"}).toThrow(TypeError)
        project.baseFrequency = 1000
        expect(project.baseFrequency).toBe(480)
        project.name = "Renamed"
        expect(project.name).toBe("Renamed")
        expect(() => {(project as any).name = 3}).toThrow(TypeError)
    })

    it("supports time signatures by object and by field", () => {
        const {project} = createFixture()
        project.timeSignature = {numerator: 7, denominator: 8}
        expect(project.timeSignature.numerator).toBe(7)
        expect(project.timeSignature.denominator).toBe(8)
        project.timeSignature.numerator = 3
        expect(project.timeSignature.numerator).toBe(3)
        expect(() => project.timeSignature = {numerator: 4, denominator: 3}).toThrow()
        expect(() => project.timeSignature = {numerator: 0, denominator: 4}).toThrow()
        expect(() => project.timeSignature.denominator = 5).toThrow()
        expect(project.timeSignature.denominator).toBe(8)
    })

    it("exposes loop area, duration, meta and groove", () => {
        const {project} = createFixture()
        project.loop.enabled = false
        project.loop.from = PPQN.Bar
        project.loop.to = PPQN.Bar * 3
        expect(project.loop.enabled).toBe(false)
        expect(project.loop.from).toBe(PPQN.Bar)
        expect(project.loop.to).toBe(PPQN.Bar * 3)
        project.duration = PPQN.Bar * 16
        expect(project.duration).toBe(PPQN.Bar * 16)
        expect(() => project.duration = 0).toThrow(RangeError)
        expect(project.meta.artist).toBe("")
        project.meta.artist = "Me"
        project.meta.tags = ["acid", "techno"]
        project.meta.notepad = "notes"
        expect(project.meta.artist).toBe("Me")
        expect(project.meta.tags).toEqual(["acid", "techno"])
        expect(project.meta.notepad).toBe("notes")
        expect(() => (project.meta as any).tags = "acid").toThrow(TypeError)
        expect(project.groove.amount).toBeCloseTo(0.6)
        project.groove.amount = 2
        expect(project.groove.amount).toBe(1)
        project.groove.duration = PPQN.SemiQuaver
        expect(project.groove.duration).toBe(PPQN.SemiQuaver)
    })

    it("manages markers", () => {
        const {project} = createFixture()
        const second = project.addMarker({position: PPQN.Bar * 2, label: "Chorus"})
        const first = project.addMarker({position: 0})
        expect(project.markers.map(marker => marker.label)).toEqual(["Marker 2", "Chorus"])
        expect(first.hue).toBe(190)
        second.plays = 3
        expect(second.plays).toBe(3)
        second.plays = -1
        expect(second.plays).toBe(0)
        first.hue = 720
        expect(first.hue).toBe(360)
        first.remove()
        expect(project.markers.length).toBe(1)
        expect(() => first.position).toThrow()
    })

    it("manages tempo events", () => {
        const {project} = createFixture()
        expect(project.tempoTrack.events.length).toBe(0)
        const event = project.tempoTrack.addEvent({position: PPQN.Bar, bpm: 90})
        project.tempoTrack.addEvent({position: 0, bpm: 5000, interpolation: Interpolation.None})
        expect(project.tempoTrack.events.map(event => event.bpm)).toEqual([1000, 90])
        expect(project.tempoTrack.events[1]).toBe(event)
        expect(event.interpolation).toEqual(Interpolation.Linear)
        event.interpolation = Interpolation.Curve(0.8)
        expect(event.interpolation.type).toBe("curve")
        expect((event.interpolation as { slope: number }).slope).toBeCloseTo(0.8)
        event.interpolation = Interpolation.None
        expect(event.interpolation).toEqual(Interpolation.None)
        expect(() => project.tempoTrack.addEvent({position: PPQN.Bar})).toThrow(RangeError)
        expect(() => event.interpolation = {type: "bogus"} as any).toThrow(TypeError)
        project.tempoTrack.enabled = false
        project.tempoTrack.minBpm = 20
        expect(project.tempoTrack.minBpm).toBe(30)
        project.tempoTrack.clearEvents()
        expect(project.tempoTrack.events.length).toBe(0)
    })

    it("manages signature events keeping absolute positions", () => {
        const {project} = createFixture()
        const bar = PPQN.Bar
        const first = project.signatureTrack.addEvent(bar * 2, 3, 4)
        expect(first.position).toBe(bar * 2)
        expect(first.numerator).toBe(3)
        expect(first.relativePosition).toBe(2)
        const threeFourBar = PPQN.fromSignature(3, 4)
        const second = project.signatureTrack.addEvent(bar * 2 + threeFourBar * 4, 7, 8)
        expect(second.position).toBe(bar * 2 + threeFourBar * 4)
        expect(second.index).toBe(1)
        expect(project.signatureTrack.events.map(event => event.numerator)).toEqual([3, 7])
        const inserted = project.signatureTrack.addEvent(bar, 5, 4)
        expect(project.signatureTrack.events.map(event => event.numerator)).toEqual([5, 3, 7])
        expect(inserted.position).toBe(bar)
        // signature changes snap to whole bars of the preceding signature (5/4 bar = 4800)
        const fiveFourBar = PPQN.fromSignature(5, 4)
        expect(first.position).toBe(bar + fiveFourBar)
        expect(second.position).toBe(bar + fiveFourBar + threeFourBar * 4)
        first.remove()
        expect(project.signatureTrack.events.map(event => event.numerator)).toEqual([5, 7])
        expect(second.index).toBe(1)
        expect(second.position).toBe(bar + fiveFourBar * Math.round((fiveFourBar + threeFourBar * 4) / fiveFourBar))
        expect(() => project.signatureTrack.addEvent(0, 4, 3)).toThrow()
        project.signatureTrack.clearEvents()
        expect(project.signatureTrack.events.length).toBe(0)
    })

    it("opens in the studio and validates", () => {
        const {project, host} = createFixture()
        project.addInstrumentUnit("Vaporisateur")
        project.openInStudio()
        expect(host.opened.length).toBe(1)
        expect(host.opened[0].name).toBe("Test")
    })
})
