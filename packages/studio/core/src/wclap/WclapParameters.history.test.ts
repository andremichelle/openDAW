import {describe, expect, it} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import {EffectFactories} from "../EffectFactories"
import {WclapParameters} from "./WclapParameters"
import {WclapStates} from "./WclapStates"

// The parameter boxes mirror what the loaded plugin reports. An undo (here of a preset load: the plugin's new
// state) must not delete them: the plugin stays loaded and reports its parameters only when it loads again.

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

describe("WebCLAP parameters and the undo history", () => {
    it("an undo after the plugin reported its parameters keeps them", async () => {
        const {Project} = await import("../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const device = project.editing.modify(() => EffectFactories.AudioNamed.Wclap
            .create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox).unwrap()
        project.editing.modify(() => {
            device.url.setValue("opfs:plugin")
            device.clapId.setValue("com.example.plugin")
        })
        const uuid = UUID.toString(device.address.uuid)
        WclapParameters.reconcile(project, uuid,
            [{id: 1, name: "Cutoff", module: "", min: 0, max: 1, defaultValue: 0, value: 0.5, flags: 1}])
        WclapStates.store(project, uuid, new Uint8Array([1, 2, 3]).buffer)
        project.editing.undo()
        expect(device.parameters.pointerHub.incoming().length).toBe(1)
        expect(device.state.getValue()).toBe("") // the preset load itself is undone
    })
})
