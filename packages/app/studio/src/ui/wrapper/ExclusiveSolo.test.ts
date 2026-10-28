import {describe, expect, it, vi} from "vitest"
import {Option, Procedure, Terminable, UUID} from "@opendaw/lib-std"
import {
    AudioEffectCompositeCellBoxAdapter, CompositeCell, InstrumentCompositeCellBoxAdapter, InstrumentFactories, ProjectSkeleton
} from "@opendaw/studio-adapters"
import {AudioEffectCompositeBox, AudioEffectCompositeCellBox, InstrumentCompositeBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import {ExclusiveSolo} from "./ExclusiveSolo"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createProject = async (): Promise<Project> => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    return Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, skeleton)
}

const layers = async (): Promise<{ project: Project, cells: ReadonlyArray<CompositeCell> }> => {
    const project = await createProject()
    const cells = project.editing.modify(() => {
        const composite = project.api.createInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox
        return [InstrumentFactories.Nano, InstrumentFactories.Vaporisateur, InstrumentFactories.Neon]
            .map(factory => project.api.createCompositeLayer(composite, factory).result().cellBox)
    }).unwrap()
    return {project, cells: cells.map(box => project.boxAdapters.adapterFor(box, InstrumentCompositeCellBoxAdapter))}
}

const entries = async (): Promise<{ project: Project, cells: ReadonlyArray<CompositeCell> }> => {
    const project = await createProject()
    const {EffectFactories} = await import("@opendaw/studio-core")
    const cells = project.editing.modify(() => {
        const {audioUnitBox} = project.api.createInstrument(InstrumentFactories.Nano)
        const composite = project.api.insertEffect(audioUnitBox.audioEffects, EffectFactories.AudioNamed.AudioEffectComposite) as AudioEffectCompositeBox
        return [0, 1, 2].map(index => AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
            box.composite.refer(composite.entries)
            box.index.setValue(index)
        }))
    }).unwrap()
    return {project, cells: cells.map(box => project.boxAdapters.adapterFor(box, AudioEffectCompositeCellBoxAdapter))}
}

// the solo checkbox element: its capture listener records the modifier of the click that toggles it
const click = (control: ReturnType<typeof ExclusiveSolo.forCell>, shiftKey: boolean, value: boolean): void => {
    const listeners: Array<Procedure<MouseEvent>> = []
    control.onInit({addEventListener: (_type: string, listener: Procedure<MouseEvent>) => listeners.push(listener)} as unknown as HTMLElement)
    listeners.forEach(listener => listener({shiftKey} as MouseEvent))
    control.model.setValue(value)
}

describe.each([["instrument layers", layers], ["FX entries", entries]])("ExclusiveSolo among %s", (_name, setup) => {
    const soloed = (cells: ReadonlyArray<CompositeCell>) => cells.map(cell => cell.namedParameter.solo.getValue())

    it("a solo click releases the other solos of the same composite", async () => {
        const {project, cells} = await setup()
        const controls = cells.map(cell => ExclusiveSolo.forCell(project.editing, cell))
        click(controls[0], false, true)
        click(controls[1], false, true)
        expect(soloed(cells)).toEqual([false, true, false])
    })

    it("shift keeps the other solos", async () => {
        const {project, cells} = await setup()
        const controls = cells.map(cell => ExclusiveSolo.forCell(project.editing, cell))
        click(controls[0], false, true)
        click(controls[2], true, true)
        expect(soloed(cells)).toEqual([true, false, true])
        click(controls[2], false, false)
        expect(soloed(cells), "un-soloing touches nothing else").toEqual([true, false, false])
    })

    it("one solo click is one undo step", async () => {
        const {project, cells} = await setup()
        const controls = cells.map(cell => ExclusiveSolo.forCell(project.editing, cell))
        click(controls[0], true, true)
        click(controls[1], true, true)
        click(controls[2], false, true)
        expect(soloed(cells)).toEqual([false, false, true])
        project.editing.undo()
        expect(soloed(cells)).toEqual([true, true, false])
    })
})
