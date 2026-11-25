import {describe, expect, it} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox, WclapInstrumentBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {BoxEditing} from "@opendaw/lib-box"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import {EffectFactories} from "../EffectFactories"
import {WclapParameters} from "./WclapParameters"

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

describe("undoing the creation of a WebCLAP device", () => {
    it("removes the device after the plugin reported its parameters", async () => {
        const {Project} = await import("../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const device = project.editing.modify(() => EffectFactories.AudioNamed.Wclap
            .create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox).unwrap()
        const uuid = device.address.uuid
        WclapParameters.reconcile(project, UUID.toString(uuid),
            [{id: 1, name: "Cutoff", module: "", min: 0, max: 1, defaultValue: 0, value: 0.5, flags: 1}])
        expect(project.editing.undo()).true
        expect(project.boxGraph.findBox(uuid).isEmpty()).true
        expect(project.boxGraph.boxes().some(box => box instanceof WclapParameterBox)).false
        expect(project.editing.redo()).true
        expect(project.boxGraph.findBox(uuid).nonEmpty()).true
    })

    const instrumentCase = async (rollback: boolean) => {
        const {Project} = await import("../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const editing = project.editing as BoxEditing
        const checkpoint = editing.checkpoint()
        const device = editing.modify(() => project.api.createInstrument(InstrumentFactories.Wclap).instrumentBox as WclapInstrumentBox, !rollback).unwrap()
        const uuid = device.address.uuid
        WclapParameters.reconcile(project, UUID.toString(uuid),
            [{id: 1, name: "Cutoff", module: "", min: 0, max: 1, defaultValue: 0, value: 0.5, flags: 1}])
        if (rollback) {checkpoint.rollback()} else {expect(editing.undo()).true}
        expect(project.boxGraph.findBox(uuid).isEmpty()).true
        expect(project.boxGraph.boxes().some(box => box instanceof WclapParameterBox)).false
    }
    it("undo removes a WebCLAP instrument", () => instrumentCase(false))
    it("a checkpoint rollback removes a WebCLAP instrument", () => instrumentCase(true))

    // a preset brings parameter boxes inside the history, the loaded plugin may not report all of them
    const presetCase = async (rollback: boolean) => {
        const {Project} = await import("../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const editing = project.editing as BoxEditing
        const unitsBefore = project.rootBox.audioUnits.pointerHub.incoming().length
        const checkpoint = editing.checkpoint()
        const device = editing.modify(() => {
            const box = project.api.createInstrument(InstrumentFactories.Wclap).instrumentBox as WclapInstrumentBox
            WclapParameterBox.create(project.boxGraph, UUID.generate(), paramBox => {
                paramBox.owner.refer(box.parameters)
                paramBox.clapId.setValue(7)
                paramBox.max.setValue(1)
            })
            return box
        }, !rollback).unwrap()
        const uuid = device.address.uuid
        WclapParameters.reconcile(project, UUID.toString(uuid),
            [{id: 1, name: "Cutoff", module: "", min: 0, max: 1, defaultValue: 0, value: 0.5, flags: 1}])
        const clapIds = project.boxGraph.boxes()
            .filter(box => box instanceof WclapParameterBox)
            .map(box => [box.clapId.getValue(), (box.flags.getValue() & 4) !== 0])
        // the unreported preset parameter stays, hidden
        expect(clapIds).toEqual(expect.arrayContaining([[7, true], [1, false]]))
        if (rollback) {checkpoint.rollback()} else {expect(editing.undo()).true}
        expect(project.boxGraph.findBox(uuid).isEmpty()).true
        expect(project.boxGraph.boxes().some(box => box instanceof WclapParameterBox)).false
        expect(project.rootBox.audioUnits.pointerHub.incoming().length).toBe(unitsBefore)
    }
    it("undo removes a WebCLAP instrument from a preset whose parameters the plugin does not all report",
        () => presetCase(false))
    it("a checkpoint rollback removes a WebCLAP instrument from a preset whose parameters the plugin does not all report",
        () => presetCase(true))
})
