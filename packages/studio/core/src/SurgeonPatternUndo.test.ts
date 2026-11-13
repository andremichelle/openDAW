import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, ProjectSkeleton, Surgeon, SurgeonDeviceBoxAdapter, SurgeonModel} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./project/ProjectEnv"

// Selecting, editing and undoing must leave every pattern as the history says, nothing may be written outside of it.

const fakeEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const setup = async () => {
    if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
    const {Project} = await import("./project/Project")
    const project = Project.fromSkeleton(fakeEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    const {editing, boxAdapters} = project
    const box = editing.modify(() => project.api.createInstrument(InstrumentFactories.Surgeon).instrumentBox, false).unwrap()
    editing.mark()
    const adapter = boxAdapters.adapterFor(box, SurgeonDeviceBoxAdapter)
    // box units rounded: defaults are doubles until a first write stores them as 32 bit floats
    const values = (model: SurgeonModel.Pattern) => JSON.stringify(Surgeon.valuesOf(model).map(([key, value]) => [key, Number(value.toFixed(5))]))
    const snapshot = () => Surgeon.Slots.filter(slot => slot !== Surgeon.Off).map(slot => values(adapter.patternModel(slot)))
    const step = (procedure: () => void) => {
        editing.modify(procedure)
        editing.mark()
    }
    return {editing, adapter, box, snapshot, step, values}
}

const SEED = 3

describe("Surgeon patterns and the history", () => {
    it("undoing a pattern switch leaves every pattern untouched", async () => {
        const {editing, adapter, box, snapshot, step} = await setup()
        const before = snapshot()
        expect(new Set(before).size).toBe(8)
        step(() => adapter.select(1))
        expect(snapshot()).toEqual(before)
        editing.undo()
        expect(box.pattern.getValue()).toBe(0)
        expect(box.slot.getValue()).toBe(0)
        expect(snapshot()).toEqual(before)
        editing.redo()
        expect(box.pattern.getValue()).toBe(1)
        expect(snapshot()).toEqual(before)
    })
    it("an edit goes to the selected pattern only, and undo takes it back", async () => {
        const {editing, adapter, snapshot, step} = await setup()
        step(() => adapter.select(2))
        const before = snapshot()
        step(() => adapter.live(SEED).setValue(4711))
        const edited = snapshot()
        expect(adapter.patternModel(2).pitch.seed).toBe(4711)
        expect(edited.filter((pattern, index) => pattern !== before[index]).length).toBe(1)
        editing.undo()
        expect(snapshot()).toEqual(before)
        editing.redo()
        expect(snapshot()).toEqual(edited)
    })
    it("an edit survives switching away and back, through undo and redo", async () => {
        const {editing, adapter, snapshot, step, values} = await setup()
        step(() => adapter.live(SEED).setValue(4711))
        const edited = snapshot()
        step(() => adapter.select(5))
        expect(snapshot()).toEqual(edited)
        expect(values(adapter.liveModel())).toBe(values(adapter.patternModel(5)))
        step(() => adapter.select(0))
        expect(adapter.liveModel().pitch.seed).toBe(4711)
        editing.undo()
        editing.undo()
        expect(snapshot()).toEqual(edited)
        expect(adapter.liveModel().pitch.seed).toBe(4711)
        editing.redo()
        editing.redo()
        expect(snapshot()).toEqual(edited)
    })
    it("selecting the selected pattern or Off keeps the live values", async () => {
        const {adapter, box, snapshot, step} = await setup()
        step(() => adapter.live(SEED).setValue(4711))
        const edited = snapshot()
        step(() => adapter.select(Surgeon.Off))
        expect(box.slot.getValue()).toBe(Surgeon.Off)
        expect(box.pattern.getValue()).toBe(0)
        step(() => adapter.select(0))
        expect(adapter.liveModel().pitch.seed).toBe(4711)
        expect(snapshot()).toEqual(edited)
    })
    it("pasting into another pattern leaves the selected one alone", async () => {
        const {editing, adapter, snapshot, step, values} = await setup()
        const before = snapshot()
        step(() => adapter.writePattern(4, adapter.patternModel(0)))
        expect(values(adapter.patternModel(4))).toBe(before[0])
        editing.undo()
        expect(snapshot()).toEqual(before)
    })
})
