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

describe("WebCLAP state bytes and the undo history", () => {
    const setup = async () => {
        const {Project} = await import("../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const device = project.editing.modify(() => EffectFactories.AudioNamed.Wclap
            .create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox).unwrap()
        project.editing.modify(() => {
            device.url.setValue("opfs:plugin")
            device.clapId.setValue("com.example.plugin")
            device.state.setValue(btoa(String.fromCharCode(9, 9)))
        })
        return {project, device, uuid: UUID.toString(device.address.uuid)}
    }

    it("a save writes the bytes and clears the legacy string, an undo restores both", async () => {
        const {project, device, uuid} = await setup()
        WclapStates.store(project, uuid, new Uint8Array([1, 2, 3]).buffer)
        expect(Array.from(device.pluginState.getValue())).toStrictEqual([1, 2, 3])
        expect(device.state.getValue()).toBe("")
        project.editing.undo()
        expect(device.pluginState.getValue().length).toBe(0)
        expect(device.state.getValue()).toBe(btoa(String.fromCharCode(9, 9)))
        expect(device.url.getValue()).toBe("opfs:plugin")
    })

    it("a redo restores the saved bytes", async () => {
        const {project, device, uuid} = await setup()
        WclapStates.store(project, uuid, new Uint8Array([4, 5]).buffer)
        project.editing.undo()
        project.editing.redo()
        expect(Array.from(device.pluginState.getValue())).toStrictEqual([4, 5])
        expect(device.state.getValue()).toBe("")
    })
})

// Update (WclapDeviceEditor.useCloud -> select) swaps url and clapId in one marked step and keeps the blob, the new
// build then saves its own format unmarked. An older build must never be handed a blob only the newer one wrote.
describe("WebCLAP Update and the undo history", () => {
    const Old = "opfs:old-build"
    const New = "opfs:new-build"
    const OldBlob = [1, 1]
    const NewBlob = [2, 2, 2]
    const setup = async () => {
        const {Project} = await import("../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const device = project.editing.modify(() => EffectFactories.AudioNamed.Wclap
            .create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox).unwrap()
        project.editing.modify(() => {
            device.url.setValue(Old)
            device.clapId.setValue("com.example.plugin")
        })
        const uuid = UUID.toString(device.address.uuid)
        WclapStates.store(project, uuid, new Int8Array(OldBlob).buffer)
        project.editing.modify(() => device.label.setValue("saved by the old build"))
        const update = (): void => {
            project.editing.modify(() => {
                device.url.setValue(New)
                device.clapId.setValue("com.example.plugin")
            })
            WclapStates.store(project, uuid, new Int8Array(NewBlob).buffer)
        }
        const blob = (): ReadonlyArray<number> => Array.from(device.pluginState.getValue())
        // the invariant: whenever the device names the old build, it holds the old build's blob
        const expectNoNewBlobOnOldBuild = (): void => {
            if (device.url.getValue() === Old) {expect(blob()).toStrictEqual(OldBlob)}
        }
        return {project, device, update, blob, expectNoNewBlobOnOldBuild}
    }

    it("the first undo reverts the new build's save, the second the Update", async () => {
        const {project, device, update, blob, expectNoNewBlobOnOldBuild} = await setup()
        update()
        expect(device.url.getValue()).toBe(New)
        expect(blob()).toStrictEqual(NewBlob)
        project.editing.undo()
        expect(device.url.getValue()).toBe(New)
        expect(blob()).toStrictEqual(OldBlob)
        project.editing.undo()
        expect(device.url.getValue()).toBe(Old)
        expectNoNewBlobOnOldBuild()
    })

    it("an edit after the Update takes the new build's save into its own step", async () => {
        const {project, device, update, blob, expectNoNewBlobOnOldBuild} = await setup()
        update()
        project.editing.modify(() => device.label.setValue("edited after the update"))
        project.editing.undo()
        expect(device.label.getValue()).toBe("saved by the old build")
        expect(device.url.getValue()).toBe(New)
        expect(blob()).toStrictEqual(OldBlob)
        project.editing.undo()
        expect(device.url.getValue()).toBe(Old)
        expectNoNewBlobOnOldBuild()
    })

    it("a redo of both steps brings back the new build with its blob", async () => {
        const {project, device, update, blob, expectNoNewBlobOnOldBuild} = await setup()
        update()
        project.editing.undo()
        project.editing.undo()
        expectNoNewBlobOnOldBuild()
        project.editing.redo()
        expect(device.url.getValue()).toBe(New)
        expect(blob()).toStrictEqual(OldBlob)
        project.editing.redo()
        expect(device.url.getValue()).toBe(New)
        expect(blob()).toStrictEqual(NewBlob)
    })
})
