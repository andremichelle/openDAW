import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ModulationBoxAdapter, ModulatorBox, ModulatorBoxAdapter, Modulators, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox, CaptureMidiBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
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

const createProject = async () => {
    const {Project} = await import("./Project")
    const {ProjectSkeleton} = await import("@opendaw/studio-adapters")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({
        createDefaultUser: true, createOutputMaximizer: false
    }))
}

// The list order as the panel renders it, so a test reads like the screen.
const labels = (project: Awaited<ReturnType<typeof createProject>>): ReadonlyArray<string> =>
    project.rootBoxAdapter.modulators.adapters().map(adapter => adapter.label)

const indices = (project: Awaited<ReturnType<typeof createProject>>): ReadonlyArray<number> =>
    project.rootBoxAdapter.modulators.adapters().map(adapter => adapter.indexField.getValue())

// The multi-selection actions the modulation panel drives: delete, duplicate and drag-reorder, each acting
// on a whole selection rather than one editor.
describe("modulator actions", () => {
    const create = async () => {
        const project = await createProject()
        // One transaction each, the way the panel's "New" menu creates them: a box only joins the
        // collection when its edges resolve on commit, so a shared transaction would give them all index 0.
        const boxes: ReadonlyArray<ModulatorBox> = [
            project.editing.modify(() => Modulators.createLfo(project, "A")).unwrap("no lfo"),
            project.editing.modify(() => Modulators.createSteps(project, "B")).unwrap("no steps"),
            project.editing.modify(() => Modulators.createMacro(project, "C")).unwrap("no macro"),
            project.editing.modify(() => Modulators.createRandom(project, "D")).unwrap("no random")
        ]
        expect(labels(project)).toEqual(["A", "B", "C", "D"])
        return {project, boxes}
    }

    describe("deleteAll", () => {
        it("removes every given modulator and closes the index gaps", async () => {
            const {project, boxes} = await create()
            project.editing.modify(() => Modulators.deleteAll(project, [boxes[0], boxes[2]]))
            expect(labels(project)).toEqual(["B", "D"])
            expect(indices(project)).toEqual([0, 1])
            project.terminate()
        })

        it("takes the assignments of every deleted modulator with it", async () => {
            const {project, boxes} = await create()
            const volume = project.parameterFieldAdapters.get(project.primaryAudioUnitBox.volume.address)
            project.editing.modify(() => Modulators.assign(project, boxes[1], volume.modulationTarget))
            expect(volume.modulations.length).toBe(1)
            project.editing.modify(() => Modulators.deleteAll(project, [boxes[1]]))
            expect(volume.modulations.length).toBe(0)
            expect(labels(project)).toEqual(["A", "C", "D"])
            expect(indices(project)).toEqual([0, 1, 2])
            project.terminate()
        })

        it("undoes as one step", async () => {
            const {project, boxes} = await create()
            project.editing.modify(() => Modulators.deleteAll(project, [boxes[0], boxes[1], boxes[2]]))
            expect(labels(project)).toEqual(["D"])
            project.editing.undo()
            expect(labels(project)).toEqual(["A", "B", "C", "D"])
            expect(indices(project)).toEqual([0, 1, 2, 3])
            project.terminate()
        })
    })

    describe("replace", () => {
        it("keeps the assignments and their depth automation, dropping the old kind's own lanes", async () => {
            const {project, boxes} = await create()
            const source = boxes[0]
            const volume = project.parameterFieldAdapters.get(project.primaryAudioUnitBox.volume.address)
            const assignment = project.editing.modify(() =>
                Modulators.assign(project, source, volume.modulationTarget)).unwrap("no assignment")
            const depth = project.boxAdapters.adapterFor(assignment, ModulationBoxAdapter).namedParameter.depth
            const sourceAdapter = project.boxAdapters.adapterFor(source, ModulatorBoxAdapter)
            project.editing.modify(() => {
                sourceAdapter.tracks.create(TrackType.Value, depth.field)
                sourceAdapter.tracks.create(TrackType.Value, sourceAdapter.amount.field)
            })
            expect(sourceAdapter.tracks.values().length).toBe(2)
            const replacement = project.editing.modify(() =>
                Modulators.replace(project, source, Modulators.Kinds[1])).unwrap("no replacement")
            expect(volume.modulations.length).toBe(1)
            const lanes = project.boxAdapters.adapterFor(replacement, ModulatorBoxAdapter).tracks
            expect(lanes.values().length).toBe(1)
            expect(lanes.controls(depth.field).nonEmpty()).toBe(true)
            project.terminate()
        })
    })

    describe("duplicateAll", () => {
        it("appends a copy of each, in list order, with unique names", async () => {
            const {project, boxes} = await create()
            const copies = project.editing.modify(() =>
                Modulators.duplicateAll(project, [boxes[2], boxes[0]])).unwrap("no copies")
            expect(copies.length).toBe(2)
            expect(labels(project)).toEqual(["A", "B", "C", "D", "A 2", "C 2"])
            expect(indices(project)).toEqual([0, 1, 2, 3, 4, 5])
            project.terminate()
        })

        it("copies the kind and the settings but no targets", async () => {
            const {project, boxes} = await create()
            const source = boxes[0]
            project.editing.modify(() => {
                source.enabled.setValue(false)
                Modulators.assign(project, source, project.parameterFieldAdapters
                    .get(project.primaryAudioUnitBox.volume.address).modulationTarget)
            })
            const [copy] = project.editing.modify(() =>
                Modulators.duplicateAll(project, [source])).unwrap("no copy")
            expect(copy.name).toBe(source.name)
            expect(copy.enabled.getValue()).toBe(false)
            expect(copy.assignments.pointerHub.incoming().length).toBe(0)
            expect(source.assignments.pointerHub.incoming().length).toBe(1)
            project.terminate()
        })
    })

    describe("move", () => {
        it("drags one modulator down onto another", async () => {
            const {project, boxes} = await create()
            project.editing.modify(() => Modulators.move(project, [boxes[0]], boxes[2]))
            expect(labels(project)).toEqual(["B", "C", "A", "D"])
            expect(indices(project)).toEqual([0, 1, 2, 3])
            project.terminate()
        })

        it("drags one modulator up onto another", async () => {
            const {project, boxes} = await create()
            project.editing.modify(() => Modulators.move(project, [boxes[3]], boxes[1]))
            expect(labels(project)).toEqual(["A", "D", "B", "C"])
            project.terminate()
        })

        it("moves a whole selection, keeping its own order", async () => {
            const {project, boxes} = await create()
            project.editing.modify(() => Modulators.move(project, [boxes[2], boxes[0]], boxes[3]))
            expect(labels(project)).toEqual(["B", "D", "A", "C"])
            expect(indices(project)).toEqual([0, 1, 2, 3])
            project.terminate()
        })

        it("ignores a drop onto a member of the dragged set", async () => {
            const {project, boxes} = await create()
            project.editing.modify(() => Modulators.move(project, [boxes[0], boxes[1]], boxes[1]))
            expect(labels(project)).toEqual(["A", "B", "C", "D"])
            project.terminate()
        })
    })

    // The panel prints "<device> <parameter>" per target, and the device's label is the user's to change.
    describe("target labels", () => {
        it("follow the device's rename", async () => {
            const {project, boxes} = await create()
            const device = project.editing.modify(() => {
                const capture = CaptureMidiBox.create(project.boxGraph, UUID.generate())
                const unit = AudioUnitBox.create(project.boxGraph, UUID.generate(), box => {
                    box.collection.refer(project.rootBox.audioUnits)
                    box.output.refer(project.primaryAudioBusBox.input)
                    box.capture.refer(capture)
                    box.index.setValue(1)
                })
                return VaporisateurDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                    box.host.refer(unit.input)
                    box.label.setValue("Vaporisateur")
                })
            }).unwrap("no device")
            const cutoff = project.parameterFieldAdapters.get(device.cutoff.address)
            project.editing.modify(() => Modulators.assign(project, boxes[0], cutoff.modulationTarget))
            const assignment = project.boxAdapters
                .adapterFor(boxes[0].assignments.pointerHub.incoming()[0].box, ModulationBoxAdapter)
            const seen: Array<string> = []
            const subscription = assignment.catchupAndSubscribeTargetOwner(name => seen.push(name))
            expect(seen).toEqual(["Vaporisateur"])
            project.editing.modify(() => device.label.setValue("Lead"))
            expect(seen).toEqual(["Vaporisateur", "Lead"])
            expect(assignment.targetOwner.unwrapOrElse("")).toBe("Lead")
            subscription.terminate()
            project.editing.modify(() => device.label.setValue("Pad"))
            expect(seen).toEqual(["Vaporisateur", "Lead"])
            project.terminate()
        })
    })
})
