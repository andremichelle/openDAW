import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {LfoModulatorBox} from "@opendaw/studio-boxes"
import {ModulatorBox, Modulators} from "@opendaw/studio-adapters"
import {ClipboardEntry} from "../ClipboardManager"
import {ModulatorsClipboard} from "./ModulatorsClipboardHandler"
import type {ProjectEnv} from "../../../project/ProjectEnv"

// jsdom lacks the Web Audio worklet globals that EngineWorklet extends at module-eval time, so a
// static import of Project would throw on load. Stub it, then import Project dynamically below.
if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
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
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined,
    audioWorklets: undefined,
    sampleManager: createSampleManager(),
    soundfontManager: undefined,
    sampleService: undefined,
    soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async () => {
    const {Project} = await import("../../../project/Project")
    const {ProjectSkeleton} = await import("@opendaw/studio-adapters")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
        createDefaultUser: true, createOutputMaximizer: false
    }))
}

type TestProject = Awaited<ReturnType<typeof createProject>>

const handlerFor = (project: TestProject, enabled: boolean = true) =>
    ModulatorsClipboard.createHandler({
        getEnabled: () => enabled,
        editing: project.editing,
        selection: project.modulatorSelection,
        boxGraph: project.boxGraph,
        boxAdapters: project.boxAdapters,
        rootBoxAdapter: () => project.rootBoxAdapter
    })

const labels = (project: TestProject): ReadonlyArray<string> =>
    project.rootBoxAdapter.modulators.adapters().map(adapter => adapter.label)

const indices = (project: TestProject): ReadonlyArray<number> =>
    project.rootBoxAdapter.modulators.adapters().map(adapter => adapter.indexField.getValue())

const select = (project: TestProject, ...boxes: ReadonlyArray<ModulatorBox>): void => {
    project.modulatorSelection.deselectAll()
    boxes.forEach(box => project.modulatorSelection.select(
        project.rootBoxAdapter.modulators.adapters()
            .find(adapter => adapter.box === box)!))
}

const noClient = {clientX: 0, clientY: 0}

// The modulation panel's copy / cut / paste. A modulator travels alone (no targets, like Duplicate), the
// copies land after the selection, and a paste into a second project joins THAT project's modulator list.
describe("ModulatorsClipboardHandler", () => {
    const create = async () => {
        const project = await createProject()
        const boxes: ReadonlyArray<ModulatorBox> = [
            project.editing.modify(() => Modulators.createLfo(project, "A")).unwrap("no lfo"),
            project.editing.modify(() => Modulators.createSteps(project, "B")).unwrap("no steps"),
            project.editing.modify(() => Modulators.createMacro(project, "C")).unwrap("no macro")
        ]
        return {project, boxes}
    }

    it("copies nothing while nothing is selected", async () => {
        const {project} = await create()
        const handler = handlerFor(project)
        expect(handler.canCopy(noClient)).toBe(false)
        expect(handler.canCut(noClient)).toBe(false)
        expect(handler.copy().isEmpty()).toBe(true)
        project.terminate()
    })

    it("refuses an entry of another type", async () => {
        const {project, boxes} = await create()
        select(project, boxes[0])
        const handler = handlerFor(project)
        const entry = handler.copy().unwrap("no entry")
        expect(handler.canPaste(entry, noClient)).toBe(true)
        expect(handler.canPaste({type: "devices", data: entry.data}, noClient)).toBe(false)
        project.terminate()
    })

    it("stays inert while disabled", async () => {
        const {project, boxes} = await create()
        select(project, boxes[0])
        const enabled = handlerFor(project)
        const entry = enabled.copy().unwrap("no entry")
        const disabled = handlerFor(project, false)
        expect(disabled.canCopy(noClient)).toBe(false)
        expect(disabled.canPaste(entry, noClient)).toBe(false)
        disabled.paste(entry)
        expect(labels(project)).toEqual(["A", "B", "C"])
        project.terminate()
    })

    it("pastes a copy right after the selection and selects it", async () => {
        const {project, boxes} = await create()
        select(project, boxes[0])
        const handler = handlerFor(project)
        handler.paste(handler.copy().unwrap("no entry"))
        expect(labels(project)).toEqual(["A", "A 2", "B", "C"])
        expect(indices(project)).toEqual([0, 1, 2, 3])
        const selected = project.modulatorSelection.selected()
        expect(selected.length).toBe(1)
        expect(selected[0].label).toBe("A 2")
        project.terminate()
    })

    it("pastes a multi-selection in list order, each with its own name", async () => {
        const {project, boxes} = await create()
        select(project, boxes[2], boxes[0])
        const handler = handlerFor(project)
        const entry = handler.copy().unwrap("no entry")
        expect(entry.count).toBe(2)
        handler.paste(entry)
        expect(labels(project)).toEqual(["A", "B", "C", "A 2", "C 2"])
        expect(indices(project)).toEqual([0, 1, 2, 3, 4])
        project.terminate()
    })

    it("pastes twice without a name collision", async () => {
        const {project, boxes} = await create()
        select(project, boxes[0])
        const handler = handlerFor(project)
        const entry = handler.copy().unwrap("no entry")
        handler.paste(entry)
        handler.paste(entry)
        expect(labels(project)).toEqual(["A", "A 2", "A 3", "B", "C"])
        project.terminate()
    })

    it("appends when nothing is selected", async () => {
        const {project, boxes} = await create()
        select(project, boxes[0])
        const handler = handlerFor(project)
        const entry = handler.copy().unwrap("no entry")
        project.modulatorSelection.deselectAll()
        handler.paste(entry)
        expect(labels(project)).toEqual(["A", "B", "C", "A 2"])
        project.terminate()
    })

    it("carries the settings but never the targets", async () => {
        const {project, boxes} = await create()
        const source = boxes[0] as LfoModulatorBox
        project.editing.modify(() => {
            source.rateSync.setValue(6)
            source.enabled.setValue(false)
            Modulators.assign(project, source, project.parameterFieldAdapters
                .get(project.primaryAudioUnitBox.volume.address).modulationTarget)
        })
        select(project, source)
        const handler = handlerFor(project)
        handler.paste(handler.copy().unwrap("no entry"))
        const copy = project.rootBoxAdapter.modulators.adapters()
            .find(adapter => adapter.label === "A 2")!.box as LfoModulatorBox
        expect(copy.name).toBe(source.name)
        expect(copy.rateSync.getValue()).toBe(6)
        expect(copy.enabled.getValue()).toBe(false)
        expect(copy.assignments.pointerHub.incoming().length).toBe(0)
        expect(project.parameterFieldAdapters
            .get(project.primaryAudioUnitBox.volume.address).modulations.length).toBe(1)
        project.terminate()
    })

    it("cuts the selection, closing the index gaps", async () => {
        const {project, boxes} = await create()
        select(project, boxes[0], boxes[1])
        const handler = handlerFor(project)
        const entry = handler.cut().unwrap("no entry")
        expect(entry.count).toBe(2)
        expect(labels(project)).toEqual(["C"])
        expect(indices(project)).toEqual([0])
        expect(project.modulatorSelection.isEmpty()).toBe(true)
        handler.paste(entry)
        expect(labels(project)).toEqual(["C", "A", "B"])
        expect(indices(project)).toEqual([0, 1, 2])
        project.terminate()
    })

    it("undoes a paste as one step", async () => {
        const {project, boxes} = await create()
        select(project, boxes[0])
        const handler = handlerFor(project)
        handler.paste(handler.copy().unwrap("no entry"))
        expect(labels(project)).toEqual(["A", "A 2", "B", "C"])
        project.editing.undo()
        expect(labels(project)).toEqual(["A", "B", "C"])
        expect(indices(project)).toEqual([0, 1, 2])
        project.terminate()
    })

    it("pastes into another project, joining ITS modulator list", async () => {
        const {project, boxes} = await create()
        const other = await createProject()
        other.editing.modify(() => Modulators.createLfo(other, "A"))
        select(project, boxes[0], boxes[1])
        const entry: ClipboardEntry = handlerFor(project).copy().unwrap("no entry")
        handlerFor(other).paste(entry)
        expect(labels(other)).toEqual(["A", "A 2", "B"])
        expect(indices(other)).toEqual([0, 1, 2])
        expect(other.rootBox.modulators.pointerHub.incoming().length).toBe(3)
        // The source project keeps its own, unchanged.
        expect(labels(project)).toEqual(["A", "B", "C"])
        other.terminate()
        project.terminate()
    })

    it("duplicates the selection without touching the clipboard", async () => {
        const {project, boxes} = await create()
        select(project, boxes[1])
        ModulatorsClipboard.duplicate({
            getEnabled: () => true,
            editing: project.editing,
            selection: project.modulatorSelection,
            boxGraph: project.boxGraph,
            boxAdapters: project.boxAdapters,
            rootBoxAdapter: () => project.rootBoxAdapter
        })
        expect(labels(project)).toEqual(["A", "B", "B 2", "C"])
        project.terminate()
    })

    describe("dragUuids", () => {
        it("drags the whole selection when the source is part of it", async () => {
            const {project, boxes} = await create()
            select(project, boxes[2], boxes[0])
            const adapters = project.rootBoxAdapter.modulators.adapters()
            const source = adapters.find(adapter => adapter.box === boxes[2])!
            expect(ModulatorsClipboard.dragUuids(project.modulatorSelection, source))
                .toEqual([UUID.toString(boxes[0].address.uuid), UUID.toString(boxes[2].address.uuid)])
            project.terminate()
        })

        it("drags only the source when it is outside the selection", async () => {
            const {project, boxes} = await create()
            select(project, boxes[0])
            const adapters = project.rootBoxAdapter.modulators.adapters()
            const source = adapters.find(adapter => adapter.box === boxes[2])!
            expect(ModulatorsClipboard.dragUuids(project.modulatorSelection, source))
                .toEqual([UUID.toString(boxes[2].address.uuid)])
            project.terminate()
        })
    })
})
