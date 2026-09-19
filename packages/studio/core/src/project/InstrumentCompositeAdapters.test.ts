import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    DeviceHost, Devices, InstrumentBox, InstrumentCompositeBoxAdapter, InstrumentCompositeCellBoxAdapter,
    InstrumentFactories, ProjectSkeleton
} from "@opendaw/studio-adapters"
import {DelayDeviceBox, InstrumentCompositeBox, PitchDeviceBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const firstLayer = (project: Project, composite: InstrumentCompositeBox): InstrumentCompositeCellBoxAdapter =>
    project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).cells.adapters()[0]

// A LAYER of an Instrument Composite is a full DeviceHost: it hosts an instrument plus both effect chains, the way
// an audio unit does, and leads back to the unit the composite lives in.
describe("Instrument Composite adapters", () => {
    it("the factory creates an empty composite, a layer is always created with its instrument", async () => {
        const project = await createProject()
        const {instrumentBox, audioUnitBox} = project.editing.modify(() =>
            project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)).unwrap()
        const composite = project.boxAdapters.adapterFor(instrumentBox, InstrumentCompositeBoxAdapter)
        expect(Devices.isInstrument(composite)).toBe(true)
        expect(composite.cells.adapters().length, "layers are added with their instrument").toBe(0)
        expect(composite.deviceHost().address.toString()).toStrictEqual(audioUnitBox.address.toString())
        const {cellBox, instrumentBox: synth} = project.editing.modify(() =>
            project.api.createCompositeLayer(composite.box, InstrumentFactories.Vaporisateur).result()).unwrap()
        const layer = composite.cells.adapters()[0]
        expect(layer.address.toString()).toStrictEqual(cellBox.address.toString())
        expect(layer.label).toBe("Vaporisateur")
        expect(layer.hostsInstrument).toBe(true)
        expect(layer.inputAdapter.unwrap("layer instrument").address.toString()).toStrictEqual(synth.address.toString())
        expect(layer.isAudioUnit).toBe(false)
        expect(layer.compositeDevice().address.toString()).toStrictEqual(composite.address.toString())
        project.editing.modify(() => project.api.createCompositeLayer(composite.box, InstrumentFactories.Nano).result())
        expect(composite.cells.adapters().map(cell => [cell.label, cell.indexField.getValue()]))
            .toStrictEqual([["Vaporisateur", 0], ["Nano", 1]])
        project.terminate()
    })

    it("only note instruments the engine can build in a layer are accepted", async () => {
        const project = await createProject()
        const {instrumentBox} = project.editing.modify(() =>
            project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)).unwrap()
        const composite = instrumentBox as InstrumentCompositeBox
        project.editing.modify(() => {
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.Tape).isFailure()).toBe(true)
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.MIDIOutput).isFailure()).toBe(true)
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.Playfield).isSuccess()).toBe(true)
            expect(project.api.createCompositeLayer(composite, InstrumentFactories.InstrumentComposite).isSuccess()).toBe(true)
        })
        expect(composite.cells.pointerHub.incoming().length, "a rejected factory creates nothing").toBe(2)
        project.terminate()
    })

    it("replacing a layer's instrument keeps the layer and its effects", async () => {
        const project = await createProject()
        const {composite, cellBox, delay} = project.editing.modify(() => {
            const composite = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
            const {cellBox} = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const delay = DelayDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(cellBox.audioEffects)
                box.index.setValue(0)
            })
            return {composite, cellBox, delay}
        }).unwrap()
        const layer = firstLayer(project, composite)
        const before = layer.inputAdapter.unwrap("before").address.toString()
        const replaced = project.editing.modify(() =>
            project.api.replaceLayerInstrument(layer.inputAdapter.unwrap("instrument").box as InstrumentBox, InstrumentFactories.Nano).result()).unwrap()
        expect(firstLayer(project, composite).address.toString(), "the layer survives").toStrictEqual(cellBox.address.toString())
        expect(layer.inputAdapter.unwrap("after").address.toString()).toStrictEqual(replaced.address.toString())
        expect(layer.inputAdapter.unwrap("after").address.toString()).not.toStrictEqual(before)
        expect(layer.audioEffects.unwrap("audio").adapters().map(effect => effect.uuid)).toStrictEqual([delay.address.uuid])
        // Like an audio unit, a layer survives losing its instrument. It then takes no midi effect (no note consumer).
        project.editing.modify(() => replaced.delete())
        expect(firstLayer(project, composite).address.toString()).toStrictEqual(cellBox.address.toString())
        expect(layer.inputAdapter.isEmpty()).toBe(true)
        expect(DeviceHost.takesEffect(layer, "midi")).toBe(false)
        expect(DeviceHost.takesEffect(layer, "audio")).toBe(true)
        const unitSynth = project.editing.modify(() => project.api.createAnyInstrument(InstrumentFactories.Nano).instrumentBox).unwrap()
        project.editing.modify(() =>
            expect(project.api.replaceLayerInstrument(unitSynth, InstrumentFactories.Vaporisateur).isFailure(),
                "an instrument on a plain unit is not a layer instrument").toBe(true))
        project.terminate()
    })

    it("a layer hosts an instrument plus both effect chains", async () => {
        const project = await createProject()
        const {composite, synth, pitch, delay, audioUnitBox} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            const {cellBox: cell, instrumentBox: synth} = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            const pitch = PitchDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(cell.midiEffects)
                box.index.setValue(0)
            })
            const delay = DelayDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(cell.audioEffects)
                box.index.setValue(0)
            })
            return {composite, synth, pitch, delay, audioUnitBox}
        }).unwrap()
        const layer = firstLayer(project, composite)
        expect(layer.inputAdapter.unwrap("layer instrument").address.toString()).toStrictEqual(synth.address.toString())
        expect(layer.midiEffects.unwrap("midi").adapters().map(effect => effect.uuid)).toStrictEqual([pitch.address.uuid])
        expect(layer.audioEffects.unwrap("audio").adapters().map(effect => effect.uuid)).toStrictEqual([delay.address.uuid])
        expect(DeviceHost.takesEffect(layer, "audio")).toBe(true)
        expect(DeviceHost.takesEffect(layer, "midi")).toBe(true)
        expect(layer.inputField.address.toString()).toStrictEqual(layer.box.instrument.address.toString())
        const synthAdapter = project.boxAdapters.adapterFor(synth, Devices.isInstrument)
        expect(synthAdapter.deviceHost().address.toString(), "the synth's host is the LAYER, not the unit").toStrictEqual(layer.address.toString())
        expect(synthAdapter.audioUnitBoxAdapter().address.toString()).toStrictEqual(audioUnitBox.address.toString())
        expect(project.boxAdapters.adapterFor(delay, Devices.isEffect).deviceHost().address.toString()).toStrictEqual(layer.address.toString())
        expect(layer.deviceHost().address.toString(), "leaving a layer returns to the unit the composite sits in")
            .toStrictEqual(audioUnitBox.address.toString())
        expect(layer.tracksField.address.toString()).toStrictEqual(audioUnitBox.tracks.address.toString())
        project.terminate()
    })

    it("layer parameters write the box fields", async () => {
        const project = await createProject()
        const composite = project.editing.modify(() => {
            const composite = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
            project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            return composite
        }).unwrap()
        const layer = firstLayer(project, composite)
        project.editing.modify(() => {
            layer.namedParameter.mute.setValue(true)
            layer.namedParameter.solo.setValue(true)
            layer.namedParameter.pan.setValue(-1.0)
            layer.namedParameter.gain.setValue(-6.0)
        })
        expect([layer.box.mute.getValue(), layer.box.solo.getValue(), layer.box.pan.getValue(), layer.box.gain.getValue()])
            .toStrictEqual([true, true, -1.0, -6.0])
        project.terminate()
    })

    it("a composite nested inside a layer still resolves its unit", async () => {
        const project = await createProject()
        const {inner, innerSynth, audioUnitBox, outerCell} = project.editing.modify(() => {
            const {instrumentBox, audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const {cellBox: outerCell, instrumentBox: inner} = project.api
                .createCompositeLayer(instrumentBox as InstrumentCompositeBox, InstrumentFactories.InstrumentComposite).result()
            const {instrumentBox: innerSynth} = project.api.createCompositeLayer(inner, InstrumentFactories.Nano).result()
            return {inner, innerSynth, audioUnitBox, outerCell}
        }).unwrap()
        const innerComposite = project.boxAdapters.adapterFor(inner, InstrumentCompositeBoxAdapter)
        expect(innerComposite.deviceHost().address.toString(), "the inner composite sits in the OUTER layer").toStrictEqual(outerCell.address.toString())
        const innerLayer = innerComposite.cells.adapters()[0]
        expect(innerLayer.deviceHost().address.toString()).toStrictEqual(outerCell.address.toString())
        expect(innerLayer.audioUnitBoxAdapter().address.toString()).toStrictEqual(audioUnitBox.address.toString())
        expect(project.boxAdapters.adapterFor(innerSynth, Devices.isInstrument).audioUnitBoxAdapter().address.toString())
            .toStrictEqual(audioUnitBox.address.toString())
        project.terminate()
    })

    it("every layer and its devices are offered as audio outputs", async () => {
        const project = await createProject()
        const {composite} = project.editing.modify(() => {
            const {instrumentBox} = project.api.createAnyInstrument(InstrumentFactories.InstrumentComposite)
            const composite = instrumentBox as InstrumentCompositeBox
            const {cellBox, instrumentBox: synth} = project.api.createCompositeLayer(composite, InstrumentFactories.Vaporisateur).result()
            cellBox.label.setValue("Bass")
            synth.label.setValue("Layer synth")
            return {composite}
        }).unwrap()
        const outputs = Array.from(project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).labeledAudioOutputs())
        expect(outputs.map(output => output.label)).toStrictEqual(["Instrument Composite", "Bass"])
        const children = Array.from(outputs[1].children().unwrap("layer children"))
        expect(children.map(output => output.label)).toContain("Layer synth")
        project.terminate()
    })
})
