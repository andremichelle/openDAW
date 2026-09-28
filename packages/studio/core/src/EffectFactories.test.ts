import {describe, expect, it} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {EffectFactories} from "./EffectFactories"
import type {ProjectEnv} from "./project/ProjectEnv"

describe("EffectFactories.keyOfBox", () => {
    const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    graph.beginTransaction()
    const make = (name: keyof BoxIO.TypeMap) => BoxIO.create(name, graph, UUID.generate())
    it("resolves regular <Key>DeviceBox effects to their factory key", () => {
        expect(EffectFactories.keyOfBox(make("DelayDeviceBox"))).toBe("Delay")
        expect(EffectFactories.keyOfBox(make("ArpeggioDeviceBox"))).toBe("Arpeggio")
        expect(EffectFactories.keyOfBox(make("AutotuneDeviceBox"))).toBe("Autotune")
    })
    it("resolves composite <Key>Box effects to their factory key", () => {
        expect(EffectFactories.keyOfBox(make("AudioEffectCompositeBox"))).toBe("AudioEffectComposite")
        expect(EffectFactories.keyOfBox(make("StereoCompositeBox"))).toBe("StereoComposite")
    })
    it("returns undefined for a box that is not a registered effect", () => {
        expect(EffectFactories.keyOfBox(make("AudioBusBox"))).toBeUndefined()
    })
    // live 1149: Sink is keyed "Sink" but creates AudioSinkDeviceBox, off the old <Key>DeviceBox convention
    it("resolves the box every factory creates back to its own key", async () => {
        const {Project} = await import("./project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const {primaryAudioUnitBox} = skeleton.mandatoryBoxes
        project.boxGraph.beginTransaction()
        Object.entries(EffectFactories.MergedNamed).forEach(([key, factory]) => {
            const field = factory.type === "midi" ? primaryAudioUnitBox.midiEffects : primaryAudioUnitBox.audioEffects
            const box = factory.create(project, field, 0)
            expect(box.name, key).toBe(factory.boxName)
            expect(EffectFactories.keyOfBox(box), key).toBe(key)
        })
        project.boxGraph.endTransaction()
        project.terminate()
    })
})

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
