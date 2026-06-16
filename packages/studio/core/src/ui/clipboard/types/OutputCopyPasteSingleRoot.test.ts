import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, ProjectSkeleton} from "@opendaw/studio-adapters"
import {RootBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitsClipboard} from "./AudioUnitsClipboardHandler"
import type {ProjectEnv} from "../../../project/ProjectEnv"

// #1008-1010: a SECOND RootBox could be grafted by copying/duplicating the Output unit. The clipboard
// handler now refuses to copy the Output unit outright (copyAudioUnit returns None), so it can never be
// pasted into a second root. This asserts that refusal on the real handler.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})
const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

describe("Output audio-unit copy/paste", () => {
    it("refuses to copy the Output unit, so it can never be pasted into a second RootBox", async () => {
        const {Project} = await import("../../../project/Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const outputBox = skeleton.mandatoryBoxes.primaryAudioUnitBox
        expect(outputBox.type.getValue()).toBe(AudioUnitType.Output)
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const {boxGraph} = project
        const outputAdapter = project.boxAdapters.adapterFor(outputBox, AudioUnitBoxAdapter)

        const handler = AudioUnitsClipboard.createHandler({
            getEnabled: () => true,
            editing: project.editing,
            boxGraph,
            rootBoxAdapter: project.rootBoxAdapter,
            audioUnitEditing: project.userEditingManager.audioUnit,
            getEditedAudioUnit: () => Option.wrap(outputAdapter)
        })

        // The Output unit is a project singleton — copying it is refused outright (no clipboard entry),
        // so it can never be pasted into a second RootBox.
        expect(handler.copy().isEmpty(), "copying the Output unit must produce no clipboard entry").toBe(true)
        // And collectDependencies never includes the RootBox in any unit's payload.
        expect(AudioUnitsClipboard.collectDependencies(outputBox, true)
            .some(box => box instanceof RootBox)).toBe(false)
        project.terminate()
    })
})
