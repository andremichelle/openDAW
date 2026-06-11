import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitsClipboard} from "./AudioUnitsClipboardHandler"
import type {ProjectEnv} from "../../../project/ProjectEnv"

// #1008-1010: the corruption is a SECOND RootBox, historically grafted by copy/pasting an Output audio
// unit before the 2026-02 fixes (c83595ae9 added the RootBox exclusion, 08e5ea6b1 added the paste UUID
// remap). This drives the REAL handler's output copy+paste on current code and asserts it stays at one root.

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
    it("does not graft a second RootBox (current code)", async () => {
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

        // copy excludes RootBox from the payload ...
        expect(AudioUnitsClipboard.collectDependencies(outputBox, true)
            .some(box => box instanceof RootBox)).toBe(false)

        const entry = handler.copy().unwrap("copy produced no clipboard entry")
        handler.paste(entry)

        const count = (ctor: Function) => boxGraph.boxes().filter(box => box instanceof ctor).length
        const outputs = boxGraph.boxes().filter((box): box is AudioUnitBox =>
            box instanceof AudioUnitBox && box.type.getValue() === AudioUnitType.Output)
        const strays = boxGraph.boxes().filter((box): box is AudioUnitBox => box instanceof AudioUnitBox)
            .filter(unit => unit.collection.targetVertex.mapOr(
                vertex => !vertex.address.equals(skeleton.mandatoryBoxes.rootBox.audioUnits.address), true))

        expect(count(RootBox), "RootBox count after output paste").toBe(1)
        expect(outputs.length, "Output unit count").toBe(1)
        expect(strays.length, "units enrolled in a foreign root").toBe(0)
        project.terminate()
    })
})
