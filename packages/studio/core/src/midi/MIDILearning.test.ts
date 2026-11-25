import {afterEach, describe, expect, it} from "vitest"
import {asInstanceOf, isDefined, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {MIDIControllerBox, UserInterfaceBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {Project} from "../project/Project"

// jsdom lacks AudioWorkletNode, which EngineWorklet extends at module-eval time.
if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: undefined,
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {},
        invalidate: () => {},
        remove: () => {},
        register: () => Terminable.Empty
    },
    soundfontManager: undefined,
    sampleService: undefined,
    soundfontService: undefined
}) as unknown as ProjectEnv

const lifecycle = new Terminator()

// Creates a project whose primary audio unit volume is mapped to controller 7.
const createLearnedProject = async (): Promise<Project> => {
    const {Project} = await import("../project/Project")
    const project = lifecycle.own(Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
        createDefaultUser: true, createOutputMaximizer: false
    })))
    const {midiControllers} = asInstanceOf(project.rootBox.users.pointerHub.incoming()[0].box, UserInterfaceBox)
    project.editing.modify(() => MIDIControllerBox.create(project.boxGraph, UUID.generate(), box => {
        box.controllers.refer(midiControllers)
        box.parameter.refer(project.primaryAudioUnitBox.volume)
        box.controlId.setValue(7)
    }))
    return project
}

// The loaded pointer holds an equal but distinct Address instance.
const reload = async (project: Project): Promise<Project> => {
    const {Project} = await import("../project/Project")
    return lifecycle.own(Project.load(createEnv(), project.toArrayBuffer() as ArrayBuffer))
}

describe("MIDILearning", () => {
    afterEach(() => lifecycle.terminate())

    it("recognises a learned parameter in the same session", async () => {
        const project = await createLearnedProject()
        expect(project.midiLearning.hasMidiConnection(project.primaryAudioUnitBox.volume.address)).toBe(true)
    })

    it("recognises a learned parameter after the project is reloaded", async () => {
        const reloaded = await reload(await createLearnedProject())
        expect(reloaded.midiLearning.hasMidiConnection(reloaded.primaryAudioUnitBox.volume.address)).toBe(true)
    })

    it("does not report another parameter of the same box as connected", async () => {
        const reloaded = await reload(await createLearnedProject())
        expect(reloaded.midiLearning.hasMidiConnection(reloaded.primaryAudioUnitBox.panning.address)).toBe(false)
    })

    it("counts the connections of a reloaded project", async () => {
        const reloaded = await reload(await createLearnedProject())
        expect(reloaded.midiLearning.numberOfConnections).toBe(1)
    })

    it("forgets a mapping after the project is reloaded and deletes its box", async () => {
        const reloaded = await reload(await createLearnedProject())
        const {volume} = reloaded.primaryAudioUnitBox
        reloaded.midiLearning.forgetMidiConnection(volume.address)
        expect(reloaded.midiLearning.hasMidiConnection(volume.address)).toBe(false)
        expect(reloaded.midiLearning.numberOfConnections).toBe(0)
        expect(reloaded.boxGraph.boxes().some(box => box instanceof MIDIControllerBox)).toBe(false)
    })
})
