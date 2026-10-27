import {describe, expect, it} from "vitest"
import {asInstanceOf, Option, Terminable, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, WclapDeviceBoxAdapter, WclapParamInfo} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import {EffectFactories} from "../EffectFactories"
import {WclapParameters} from "./WclapParameters"

// Live error 1175. Switching a device to another plugin reconciles the existing parameter boxes whose clap ids
// match. min and max were written one after the other, and the parameter adapter rebuilds its value mapping on
// each write, so a new min at or above the old max meets an inverted range: "Linear is inverse".

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

const param = (min: number, max: number): WclapParamInfo =>
    ({id: 1, name: "Cutoff", module: "", min, max, defaultValue: min, value: min, flags: 0})

const setup = async () => {
    const {Project} = await import("../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const device = project.editing.modify(() => EffectFactories.AudioNamed.Wclap
        .create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox).unwrap()
    project.boxAdapters.adapterFor(device, WclapDeviceBoxAdapter)
    return {project, device, uuid: UUID.toString(device.address.uuid)}
}

describe("a parameter range changed by another plugin (1175)", () => {
    it("moves up past the old max", async () => {
        const {project, device, uuid} = await setup()
        WclapParameters.reconcile(project, uuid, [param(0, 1)])
        expect(() => WclapParameters.reconcile(project, uuid, [param(20, 20000)])).not.toThrow()
        const paramBox = asInstanceOf(device.parameters.pointerHub.incoming()[0].box, WclapParameterBox)
        expect([paramBox.min.getValue(), paramBox.max.getValue()]).toEqual([20, 20000])
    })
    it("moves down below the old min", async () => {
        const {project, uuid} = await setup()
        WclapParameters.reconcile(project, uuid, [param(20, 20000)])
        expect(() => WclapParameters.reconcile(project, uuid, [param(-10, 0)])).not.toThrow()
    })
})
