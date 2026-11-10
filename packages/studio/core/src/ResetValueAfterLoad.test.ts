import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, ReverbDeviceBox, RevampDeviceBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitType, IconSymbol} from "@opendaw/studio-enums"
import {EffectParameterDefaults} from "./EffectParameterDefaults"

// live error 1206: a loaded box had initValue 0, so "Reset Value" set the Revamp high-pass Q to 0 (NaN output)
describe("Reset Value on a loaded box restores the factory default", () => {
    const reload = (source: BoxGraph<BoxIO.TypeMap>): BoxGraph<BoxIO.TypeMap> => {
        const loaded = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        loaded.fromArrayBuffer(source.toArrayBuffer(), false)
        return loaded
    }
    const create = () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox, primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const revamp = RevampDeviceBox.create(boxGraph, UUID.generate(), box => {
            EffectParameterDefaults.defaultRevampDeviceBox(box)
            box.host.refer(primaryAudioUnitBox.audioEffects)
        })
        const reverb = ReverbDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.preDelay.setInitValue(0.001)
            box.host.refer(primaryAudioUnitBox.audioEffects)
        })
        const instrumentUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.type.setValue(AudioUnitType.Instrument)
            box.index.setValue(1)
        })
        const vaporisateur = InstrumentFactories.Vaporisateur.create(
            boxGraph, instrumentUnit.input, "Vaporisateur", IconSymbol.Piano)
        boxGraph.endTransaction()
        return {boxGraph, revamp, reverb, vaporisateur}
    }
    it("Revamp Q, order and gain", () => {
        const {boxGraph, revamp: {address: {uuid}}} = create()
        const loaded = reload(boxGraph)
        const box = loaded.findBox<RevampDeviceBox>(uuid).unwrap()
        loaded.beginTransaction()
        box.highPass.q.setValue(4.0)
        box.lowPass.q.setValue(4.0)
        box.midBell.q.setValue(4.0)
        box.highPass.order.setValue(3)
        box.highShelf.gain.setValue(-12.0)
        box.midBell.gain.setValue(-12.0)
        ;[box.highPass.q, box.lowPass.q, box.midBell.q, box.highPass.order, box.highShelf.gain, box.midBell.gain]
            .forEach(field => field.reset())
        loaded.endTransaction()
        expect(box.highPass.q.getValue()).toBeCloseTo(Math.SQRT1_2, 6)
        expect(box.lowPass.q.getValue()).toBeCloseTo(Math.SQRT1_2, 6)
        expect(box.midBell.q.getValue()).toBeCloseTo(Math.SQRT1_2, 6)
        expect(box.highPass.order.getValue()).toBe(1)
        expect(box.highShelf.gain.getValue()).toBe(6.0)
        expect(box.midBell.gain.getValue()).toBe(6.0)
    })
    it("Reverb pre-delay", () => {
        const {boxGraph, reverb: {address: {uuid}}} = create()
        const loaded = reload(boxGraph)
        const box = loaded.findBox<ReverbDeviceBox>(uuid).unwrap()
        expect(box.preDelay.initValue).toBeCloseTo(0.001, 6)
    })
    it("Vaporisateur filter and envelope", () => {
        const {boxGraph, vaporisateur: {address: {uuid}}} = create()
        const loaded = reload(boxGraph)
        const box = loaded.findBox<VaporisateurDeviceBox>(uuid).unwrap()
        expect(box.cutoff.initValue).toBe(8000.0)
        expect(box.resonance.initValue).toBeCloseTo(0.1, 6)
        expect(box.attack.initValue).toBeCloseTo(0.005, 6)
        expect(box.release.initValue).toBe(0.5)
    })
    it("stored values still win over the schema defaults", () => {
        const {boxGraph, revamp} = create()
        boxGraph.beginTransaction()
        revamp.highPass.q.setValue(2.5)
        boxGraph.endTransaction()
        const box = reload(boxGraph).findBox<RevampDeviceBox>(revamp.address.uuid).unwrap()
        expect(box.highPass.q.getValue()).toBe(2.5)
    })
})
