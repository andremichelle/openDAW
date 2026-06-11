import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton, TransferAudioUnits} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./ProjectEnv"

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

// The global "copy-device" shortcut duplicates the edited unit via TransferAudioUnits.transfer, whose
// excludeBox does NOT exclude RootBox. Test duplicating a preset-loaded unit and the Output unit.
describe("Duplicate audio unit (copy-device)", () => {
    const build = async () => {
        const {Project} = await import("./Project")
        return Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    }
    const roots = (project: any) => project.boxGraph.boxes().filter((box: unknown) => box instanceof RootBox).length

    it("refuses to duplicate the Output unit (no second root, no copy) — #1005-1010", async () => {
        const project = await build()
        const outputBox = project.boxGraph.boxes().find((box): box is AudioUnitBox =>
            box instanceof AudioUnitBox && box.type.getValue() === AudioUnitType.Output)!
        let copies: ReadonlyArray<AudioUnitBox> = []
        project.editing.modify(() => {copies = TransferAudioUnits.transfer([outputBox], project.skeleton)})
        const outputs = project.boxGraph.boxes().filter((box): box is AudioUnitBox =>
            box instanceof AudioUnitBox && box.type.getValue() === AudioUnitType.Output).length
        console.info(`duplicate-output: roots=${roots(project)} outputs=${outputs} copies=${copies.length}`)
        expect(roots(project), "RootBox count after attempting to duplicate output").toBe(1)
        expect(outputs, "Output unit count").toBe(1)
        expect(copies.length, "transfer must not copy the Output unit").toBe(0)
        project.terminate()
    })
})
