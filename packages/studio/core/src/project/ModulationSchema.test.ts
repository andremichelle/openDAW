import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {LfoModulatorBox, ModulationBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import type {ProjectEnv} from "./ProjectEnv"

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

// Phase 2 of plans/modulations.md: the boxes exist, they survive a `.od` round-trip, and the pointer rules
// wire a modulator to a device parameter. Nothing evaluates them yet — that is phase 3.
describe("modulation schema", () => {
    it("an LFO and its assignment survive a project round-trip", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
            createDefaultUser: true, createOutputMaximizer: false
        }))
        const lfoUuid = UUID.generate()
        const modulationUuid = UUID.generate()
        const target = project.primaryAudioUnitBox.volume
        project.editing.modify(() => {
            const lfo = LfoModulatorBox.create(project.boxGraph, lfoUuid, box => {
                box.collection.refer(project.rootBox.modulators)
                box.label.setValue("Wobble")
                box.rate.setValue(6)
                box.phase.setValue(0.25)
            })
            ModulationBox.create(project.boxGraph, modulationUuid, box => {
                box.source.refer(lfo.assignments)
                box.target.refer(target)
                box.depth.setValue(-0.5)
            })
        })
        const reloaded = await Project.load(createEnv(), project.toArrayBuffer() as ArrayBuffer)
        const lfo = reloaded.boxGraph.findBox<LfoModulatorBox>(lfoUuid).unwrap()
        expect(lfo.label.getValue()).toBe("Wobble")
        expect(lfo.rate.getValue()).toBe(6)
        expect(lfo.phase.getValue()).toBeCloseTo(0.25)
        expect(lfo.enabled.getValue()).toBe(true)
        expect(lfo.amount.getValue()).toBeCloseTo(1.0)
        const modulation = reloaded.boxGraph.findBox<ModulationBox>(modulationUuid).unwrap()
        expect(modulation.depth.getValue()).toBeCloseTo(-0.5)
        expect(modulation.enabled.getValue()).toBe(true)
        // Both edges survive: the assignment hangs off the LFO, and it points at the parameter FIELD.
        expect(modulation.source.targetVertex.unwrap().address.equals(lfo.assignments.address)).toBe(true)
        expect(modulation.target.targetVertex.unwrap().address
            .equals(reloaded.primaryAudioUnitBox.volume.address)).toBe(true)
        expect(reloaded.rootBox.modulators.pointerHub.incoming().length).toBe(1)
        reloaded.terminate()
        project.terminate()
    })

    it("the parameter reports a modulated control source", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
            createDefaultUser: true, createOutputMaximizer: false
        }))
        const field = project.primaryAudioUnitBox.volume
        const parameter = project.parameterFieldAdapters.get(field.address)
        const sources: Array<string> = []
        parameter.catchupAndSubscribeControlSources({
            onControlSourceAdd: source => sources.push(source),
            onControlSourceRemove: source => sources.splice(sources.indexOf(source), 1)
        })
        expect(sources).toEqual([])
        const modulationUuid = UUID.generate()
        project.editing.modify(() => {
            const lfo = LfoModulatorBox.create(project.boxGraph, UUID.generate(), box =>
                box.collection.refer(project.rootBox.modulators))
            ModulationBox.create(project.boxGraph, modulationUuid, box => {
                box.source.refer(lfo.assignments)
                box.target.refer(field)
            })
        })
        expect(sources).toEqual(["modulated"])
        project.editing.modify(() =>
            project.boxGraph.findBox<ModulationBox>(modulationUuid).unwrap().delete())
        expect(sources).toEqual([])
        project.terminate()
    })

    it("deleting the modulator takes its assignments with it", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
            createDefaultUser: true, createOutputMaximizer: false
        }))
        const lfoUuid = UUID.generate()
        const modulationUuid = UUID.generate()
        project.editing.modify(() => {
            const lfo = LfoModulatorBox.create(project.boxGraph, lfoUuid, box =>
                box.collection.refer(project.rootBox.modulators))
            ModulationBox.create(project.boxGraph, modulationUuid, box => {
                box.source.refer(lfo.assignments)
                box.target.refer(project.primaryAudioUnitBox.volume)
            })
        })
        project.editing.modify(() => project.boxGraph.findBox<LfoModulatorBox>(lfoUuid).unwrap().delete())
        expect(project.boxGraph.findBox(modulationUuid).isEmpty()).toBe(true)
        expect(project.boxGraph.findBox(lfoUuid).isEmpty()).toBe(true)
        // Pointers.Modulation is accepted by every parameter field, so nothing is left dangling on the target.
        expect(project.primaryAudioUnitBox.volume.pointerHub.filter(Pointers.Modulation).length).toBe(0)
        project.terminate()
    })
})
