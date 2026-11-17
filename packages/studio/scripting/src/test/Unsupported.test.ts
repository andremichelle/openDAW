import {describe, expect, it} from "vitest"
import {PPQN} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {Box, Field} from "@opendaw/lib-box"
import {
    AudioUnitBox,
    KorpusDeviceBox,
    ModularBox,
    ModularDeviceBox,
    NoopInstrumentBox,
    RootBox,
    UnknownAudioEffectDeviceBox,
    UnknownMidiEffectDeviceBox,
    WclapDeviceBox,
    WclapInstrumentBox,
    WclapMidiEffectBox
} from "@opendaw/studio-boxes"
import {createFixture, impl} from "./Fixture"
import {Facade} from "../impl/Common"
import {InstrumentAudioUnit, Project} from "../Api"

// Scripts cannot create these devices, so the tests build them in the box graph like a loaded project would hold them
const boxOf = (facade: unknown): Box => (facade as Facade).box

const instrumentUnit = (project: Project, create: (host: Field) => Box): InstrumentAudioUnit => {
    const unit = project.addInstrumentUnit("Vaporisateur", {label: "Synth"})
    const {context} = impl(project)
    const unitBox = boxOf(unit) as AudioUnitBox
    context.edit(() => {
        boxOf(unit.instrument).delete()
        create(unitBox.input)
    })
    return unit
}

const wclapInstrument = (project: Project): InstrumentAudioUnit => instrumentUnit(project, host =>
    WclapInstrumentBox.create(impl(project).context.boxGraph, UUID.generate(), box => {
        box.host.refer(host)
        box.label.setValue("Plugin Synth")
    }))

describe("Unsupported devices", () => {
    it("reaches units with a WebCLAP, Korpus or Noop instrument", () => {
        const {project} = createFixture()
        const wclap = wclapInstrument(project)
        const korpus = instrumentUnit(project, host => KorpusDeviceBox.create(impl(project).context.boxGraph, UUID.generate(), box => {
            box.host.refer(host)
            box.label.setValue("Body")
        }))
        const noop = instrumentUnit(project, host => NoopInstrumentBox.create(impl(project).context.boxGraph, UUID.generate(), box => {
            box.host.refer(host)
            box.label.setValue("Placeholder")
        }))
        expect(project.instrumentUnits.map(unit => unit.label)).toEqual(["Plugin Synth", "Body", "Placeholder"])
        expect(project.instrumentUnits.map(unit => unit.instrument.key)).toEqual(["WebCLAP", "Korpus", "Noop"])
        expect(project.findAudioUnit("Body")).toBe(korpus)
        expect(project.findByUuid(wclap.instrument.uuid)).toBe(wclap.instrument)
        expect(wclap.instrument.audioUnit).toBe(wclap)
        expect(noop.instrument.enabled).toBe(true)
    })

    it("edits label, enabled and minimized of an unsupported instrument", () => {
        const {project} = createFixture()
        const unit = wclapInstrument(project)
        unit.label = "Renamed"
        unit.instrument.enabled = false
        unit.instrument.minimized = true
        expect(unit.instrument.label).toBe("Renamed")
        expect(unit.instrument.enabled).toBe(false)
        expect(unit.instrument.minimized).toBe(true)
        expect(() => project.validate()).not.toThrow()
    })

    it("edits notes on the track of a WebCLAP unit", () => {
        const {project} = createFixture()
        const unit = wclapInstrument(project)
        const region = unit.noteTracks[0].addRegion({position: 0, duration: PPQN.Bar})
        const note = region.addEvent({position: 0, pitch: 60, duration: PPQN.Quarter})
        expect(project.findByUuid(note.uuid)).toBe(note)
        expect(region.events.map(event => event.pitch)).toEqual([60])
    })

    it("replaces an unsupported instrument with a supported one", () => {
        const {project} = createFixture()
        const unit = wclapInstrument(project)
        const nano = unit.setInstrument("Nano")
        expect(unit.instrument).toBe(nano)
        expect(unit.noteTracks.length).toBe(1)
        expect(() => project.validate()).not.toThrow()
    })

    it("lists, moves and removes unsupported effects", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        unit.addMIDIEffect("Pitch")
        unit.addAudioEffect("Delay")
        const {context} = impl(project)
        const {boxGraph} = context
        const unitBox = boxOf(unit) as AudioUnitBox
        context.edit(() => {
            WclapMidiEffectBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(unitBox.midiEffects)
                box.index.setValue(1)
            })
            UnknownMidiEffectDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(unitBox.midiEffects)
                box.index.setValue(2)
            })
            WclapDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(unitBox.audioEffects)
                box.index.setValue(1)
            })
            const rootBox = boxGraph.boxes().find((box): box is RootBox => box instanceof RootBox)!
            const setup = ModularBox.create(boxGraph, UUID.generate(), box => box.collection.refer(rootBox.modularSetups))
            ModularDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(unitBox.audioEffects)
                box.index.setValue(2)
                box.modularSetup.refer(setup.device)
            })
            UnknownAudioEffectDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(unitBox.audioEffects)
                box.index.setValue(3)
            })
        })
        expect(unit.midiEffects.map(effect => effect.key)).toEqual(["Pitch", "WebCLAP", "Unknown"])
        expect(unit.audioEffects.map(effect => effect.key)).toEqual(["Delay", "WebCLAP", "Modular", "Unknown"])
        const plugin = unit.audioEffects[1]
        expect(project.findByUuid(plugin.uuid)).toBe(plugin)
        expect(plugin.audioUnit).toBe(unit)
        plugin.move(0)
        expect(unit.audioEffects.map(effect => effect.key)).toEqual(["WebCLAP", "Delay", "Modular", "Unknown"])
        unit.midiEffects[2].remove()
        expect(unit.midiEffects.map(effect => effect.key)).toEqual(["Pitch", "WebCLAP"])
        expect(() => project.validate()).not.toThrow()
    })
})
