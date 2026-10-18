import {describe, expect, it} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {NativeInstrumentBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {InstrumentFactory, ProjectSkeleton, TrackType, WclapParamInfo} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import type {ProjectEnv} from "@opendaw/studio-core"

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

// studio-core's index touches the worklet globals node does not have
const load = async () => {
    Object.assign(globalThis, {AudioWorkletNode: class {}})
    const [{Project, WclapParameters}, {NativeState}] = await Promise.all([import("@opendaw/studio-core"), import("./NativeState")])
    return {Project, WclapParameters, NativeState}
}

const factory: InstrumentFactory<void, NativeInstrumentBox> = {
    defaultName: "Serum 2", defaultIcon: IconSymbol.Piano, briefDescription: "Plugin", description: "", manualPage: "",
    trackType: TrackType.Notes,
    create: (boxGraph, host, name, icon) => NativeInstrumentBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue(name)
        box.icon.setValue(IconSymbol.toName(icon))
        box.host.refer(host)
    })
}

// The plugin keeps its own history (Serum's undo). The state it saved (window closed, project saved) must not join the
// studio's next action, else undoing that action loads an older state into the plugin.
describe("a plugin's saved state", () => {
    it("stays when the next action is undone and redone", async () => {
        const {Project, NativeState} = await load()
        const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {editing, timelineBox} = project
        const {instrumentBox} = editing.modify(() => project.api.createAnyInstrument(factory)).unwrap()
        const box = instrumentBox as NativeInstrumentBox
        const saved = new Int8Array([1, 2, 3])
        NativeState.store(project, box, saved)
        editing.modify(() => timelineBox.bpm.setValue(140))
        expect(editing.undo()).toBe(true)
        expect(timelineBox.bpm.getValue()).not.toBe(140)
        expect(Array.from(box.state.getValue())).toEqual([1, 2, 3])
        expect(editing.redo()).toBe(true)
        expect(Array.from(box.state.getValue())).toEqual([1, 2, 3])
    })
})

const params = ["Cutoff", "Resonance"].map((name, id): WclapParamInfo =>
    ({id, name, module: "", min: 0, max: 1, defaultValue: 0.5, value: 0.5, flags: 0}))

// A knob turned in the plugin's window (or by its own undo, a preset) is the plugin's: no undo step, nothing pending that
// would join the next action or block a redo. Automation recording still sees the write.
describe("an edit in the plugin", () => {
    it("sets the value outside the history and reaches automation recording", async () => {
        const {Project, WclapParameters, NativeState} = await load()
        const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {editing, timelineBox} = project
        const {instrumentBox} = editing.modify(() => project.api.createAnyInstrument(factory), false).unwrap()
        const hub = (instrumentBox as NativeInstrumentBox).parameters
        editing.modify(() => WclapParameters.reconcileHub(project, hub, params), false)
        editing.mark()
        const cutoff = () => hub.pointerHub.incoming().map(({box}) => box as WclapParameterBox)
            .find(box => box.clapId.getValue() === 0)!.value.getValue()
        project.boxAdapters.adapterFor(instrumentBox, (await import("@opendaw/studio-adapters")).Devices.isInstrument)
        const writes: Array<number> = []
        project.parameterFieldAdapters.subscribeWrites(({adapter}) => writes.push(adapter.getValue() as number))
        editing.modify(() => timelineBox.bpm.setValue(140))
        NativeState.edit(project, hub, 0, 0.8)
        expect(cutoff()).toBeCloseTo(0.8)
        expect(writes.length).toBe(1)
        expect(writes[0]).toBeCloseTo(0.8)
        expect(editing.undo()).toBe(true)
        expect(timelineBox.bpm.getValue()).not.toBe(140)
        expect(cutoff()).toBeCloseTo(0.8)
        expect(editing.redo()).toBe(true)
        expect(timelineBox.bpm.getValue()).toBe(140)
        expect(cutoff()).toBeCloseTo(0.8)
        expect(editing.canRedo()).toBe(false)
    })
})
