import {afterEach, describe, expect, it, vi} from "vitest"
import {Option, panic, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, WclapStatus} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {Project} from "../project/Project"
import {EffectFactories} from "../EffectFactories"
import {WclapFailures} from "./WclapFailures"

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<{ project: Project, uuid: string }> => {
    const {Project} = await import("../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(createEnv(), skeleton)
    project.boxGraph.beginTransaction()
    const device = EffectFactories.AudioNamed.Wclap.create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0)
    if (!(device instanceof WclapDeviceBox)) {return panic("expected a WclapDeviceBox")}
    device.label.setValue("Room")
    device.clapId.setValue("uk.co.signalsmith.basics.reverb")
    project.boxGraph.endTransaction()
    return {project, uuid: UUID.toString(device.address.uuid)}
}

const failed: WclapStatus = {state: "failed", message: "WebCLAP bundle abc is not stored", inputs: []}
const loading: WclapStatus = {state: "loading", message: "", inputs: []}
const ready: WclapStatus = {state: "ready", message: "", inputs: []}

describe("WclapFailures", () => {
    afterEach(() => vi.restoreAllMocks())

    it("notifies once when a device fails, naming the device, the plugin and the reason", async () => {
        const notify = vi.spyOn(RuntimeNotifier, "notify").mockImplementation(() => {})
        const {project, uuid} = await createProject()
        WclapFailures.report(project, uuid, loading, failed)
        WclapFailures.report(project, uuid, failed, failed)
        expect(notify).toHaveBeenCalledTimes(1)
        const message = String(notify.mock.calls[0][0].message)
        expect(message).toContain("Room")
        expect(message).toContain("uk.co.signalsmith.basics.reverb")
        expect(message).toContain("is not stored")
    })

    it("notifies again after the device was ready in between", async () => {
        const notify = vi.spyOn(RuntimeNotifier, "notify").mockImplementation(() => {})
        const {project, uuid} = await createProject()
        WclapFailures.report(project, uuid, undefined, failed)
        WclapFailures.report(project, uuid, failed, loading)
        WclapFailures.report(project, uuid, loading, ready)
        WclapFailures.report(project, uuid, ready, failed)
        expect(notify).toHaveBeenCalledTimes(2)
    })

    it("stays quiet for loading and ready", async () => {
        const notify = vi.spyOn(RuntimeNotifier, "notify").mockImplementation(() => {})
        const {project, uuid} = await createProject()
        WclapFailures.report(project, uuid, undefined, loading)
        WclapFailures.report(project, uuid, loading, ready)
        expect(notify).not.toHaveBeenCalled()
    })
})
