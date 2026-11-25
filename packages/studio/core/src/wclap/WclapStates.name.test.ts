import {describe, expect, it} from "vitest"
import {Option, Optional, Terminable, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import {EffectFactories} from "../EffectFactories"
import {WclapStates} from "./WclapStates"

// A WebCLAP device takes the name of the plugin it hosts, a name the user gave it stays.

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

const setup = async () => {
    const {Project} = await import("../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const effect = () => project.editing.modify(() => EffectFactories.AudioNamed.Wclap
        .create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0) as WclapDeviceBox).unwrap()
    const instrument = () => project.editing.modify(() =>
        project.api.createAnyInstrument(InstrumentFactories.Wclap).instrumentBox as WclapInstrumentBox).unwrap()
    const name = (box: WclapDeviceBox | WclapInstrumentBox, previous: Optional<string>, next: string) =>
        project.editing.modify(() => WclapStates.name(project, box, previous, next))
    return {project, effect, instrument, name}
}

describe("WclapStates.name", () => {
    it("an effect named WebCLAP takes the plugin's name", async () => {
        const {effect, name} = await setup()
        const device = effect()
        name(device, undefined, "Xenon")
        expect(device.label.getValue()).toBe("Xenon")
    })
    it("another plugin replaces the previous plugin's name", async () => {
        const {effect, name} = await setup()
        const device = effect()
        name(device, undefined, "Xenon")
        name(device, "Xenon", "Rotor")
        expect(device.label.getValue()).toBe("Rotor")
    })
    it("a name the user gave stays", async () => {
        const {project, effect, name} = await setup()
        const device = effect()
        name(device, undefined, "Xenon")
        project.editing.modify(() => device.label.setValue("Clouds"))
        name(device, "Xenon", "Rotor")
        expect(device.label.getValue()).toBe("Clouds")
    })
    it("a plugin unknown before (still loading) replaces only the default name", async () => {
        const {project, effect, name} = await setup()
        const device = effect()
        project.editing.modify(() => device.label.setValue("Clouds"))
        name(device, undefined, "Rotor")
        expect(device.label.getValue()).toBe("Clouds")
    })
    it("numbered instruments take unique plugin names", async () => {
        const {instrument, name} = await setup()
        const first = instrument()
        const second = instrument()
        expect(second.label.getValue()).toBe("WebCLAP 2")
        name(first, undefined, "Xenon")
        name(second, undefined, "Xenon")
        expect(first.label.getValue()).toBe("Xenon")
        expect(second.label.getValue()).toBe("Xenon 2")
    })
    it("a numbered instrument keeps its own number free when it switches plugins", async () => {
        const {instrument, name} = await setup()
        const first = instrument()
        const second = instrument()
        name(first, undefined, "Xenon")
        name(second, undefined, "Xenon")
        name(second, "Xenon", "Rotor")
        expect(second.label.getValue()).toBe("Rotor")
    })
    it("undo restores the previous name", async () => {
        const {project, effect, name} = await setup()
        const device = effect()
        name(device, undefined, "Xenon")
        project.editing.undo()
        expect(device.label.getValue()).toBe("WebCLAP")
    })
})
