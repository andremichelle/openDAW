import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {IndexedBox} from "@opendaw/lib-box"
import {InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
    AudioUnitBox,
    DelayDeviceBox,
    LfoModulatorBox,
    ModulationBox
} from "@opendaw/studio-boxes"
import {EffectFactories} from "../EffectFactories"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

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
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const chainOf = (unit: AudioUnitBox) => IndexedBox.collectIndexedBoxes(unit.audioEffects)
const uuidsOf = (boxes: ReadonlyArray<{ address: { uuid: UUID.Bytes } }>) => boxes.map(box => UUID.toString(box.address.uuid))

// An ALT drop of effects copies them into the target chain: the source chain keeps its boxes, the copies are
// new boxes with the same values, and they take the drop index while the rest of the target chain shifts.
describe("ProjectApi.copyEffects", () => {
    it("copies into the same chain at the index, keeping values and shifting the rest", async () => {
        const project = await createProject()
        const {api, editing} = project
        const {unit, delayA, delayB} = editing.modify(() => {
            const unit = api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
            const delayA = api.insertEffect(unit.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            const delayB = api.insertEffect(unit.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            delayA.feedback.setValue(0.8)
            return {unit, delayA, delayB}
        }).unwrap()
        const copies = editing.modify(() => api.copyEffects(unit.audioEffects, [delayA], 1)).unwrap()
        expect(copies.length).toBe(1)
        const copy = copies[0] as DelayDeviceBox
        expect(copy).not.toBe(delayA)
        expect(copy.feedback.getValue()).toBeCloseTo(0.8)
        expect(uuidsOf(chainOf(unit))).toEqual(uuidsOf([delayA, copy, delayB]))
        expect(chainOf(unit).map(box => box.index.getValue())).toEqual([0, 1, 2])
        project.terminate()
    })

    it("copies several effects into another unit's chain in their chain order, source untouched", async () => {
        const project = await createProject()
        const {api, editing} = project
        const {source, target, delayA, delayB, existing} = editing.modify(() => {
            const source = api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
            const target = api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
            const delayA = api.insertEffect(source.audioEffects, EffectFactories.AudioNamed.Delay)
            const delayB = api.insertEffect(source.audioEffects, EffectFactories.AudioNamed.Delay)
            const existing = api.insertEffect(target.audioEffects, EffectFactories.AudioNamed.Crusher)
            return {source, target, delayA, delayB, existing}
        }).unwrap()
        const copies = editing.modify(() => api.copyEffects(target.audioEffects, [delayB, delayA], 0)).unwrap()
        expect(uuidsOf(chainOf(source))).toEqual(uuidsOf([delayA, delayB]))
        expect(chainOf(target).length).toBe(3)
        expect(uuidsOf(chainOf(target))).toEqual(uuidsOf([...copies, existing]))
        expect(copies.every(copy => copy.host.targetVertex.unwrap().address.equals(target.audioEffects.address))).toBe(true)
        expect(new Set(uuidsOf([...copies, delayA, delayB])).size).toBe(4)
        project.terminate()
    })

    it("keeps a copied effect modulated by the same modulator", async () => {
        const project = await createProject()
        const {api, editing, boxGraph, rootBox} = project
        const {unit, delay, lfo} = editing.modify(() => {
            const unit = api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
            const delay = api.insertEffect(unit.audioEffects, EffectFactories.AudioNamed.Delay) as DelayDeviceBox
            const lfo = LfoModulatorBox.create(boxGraph, UUID.generate(), box => box.collection.refer(rootBox.modulators))
            ModulationBox.create(boxGraph, UUID.generate(), box => {
                box.source.refer(lfo.assignments)
                box.target.refer(delay.feedback)
                box.depth.setValue(-0.5)
            })
            return {unit, delay, lfo}
        }).unwrap()
        const [copy] = editing.modify(() => api.copyEffects(unit.audioEffects, [delay], 1)).unwrap() as ReadonlyArray<DelayDeviceBox>
        const modulations = boxGraph.boxes().filter((box): box is ModulationBox => box instanceof ModulationBox)
        expect(modulations.length).toBe(2)
        const onCopy = modulations.find(box => box.target.targetVertex.unwrap().address.equals(copy.feedback.address))
        expect(isDefined(onCopy)).toBe(true)
        expect(onCopy?.source.targetVertex.unwrap().address.equals(lfo.assignments.address)).toBe(true)
        expect(onCopy?.depth.getValue()).toBeCloseTo(-0.5)
        expect(rootBox.modulators.pointerHub.incoming().length).toBe(1)
        project.terminate()
    })

    it("copies a composite with its entries and their nested effects", async () => {
        const project = await createProject()
        const {api, editing, boxGraph} = project
        const {source, target, composite, nested} = editing.modify(() => {
            const source = api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
            const target = api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
            const composite = AudioEffectCompositeBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(source.audioEffects)
                box.index.setValue(0)
            })
            const cell = AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            const nested = api.insertEffect(cell.audioEffects, EffectFactories.AudioNamed.Delay)
            return {source, target, composite, nested}
        }).unwrap()
        const copies = editing.modify(() => api.copyEffects(target.audioEffects, [composite], 0)).unwrap()
        expect(copies.length).toBe(1)
        const copy = copies[0] as AudioEffectCompositeBox
        expect(copy).toBeInstanceOf(AudioEffectCompositeBox)
        expect(copy).not.toBe(composite)
        const copiedCells = copy.entries.pointerHub.incoming().map(({box}) => box as AudioEffectCompositeCellBox)
        expect(copiedCells.length).toBe(1)
        const copiedNested = IndexedBox.collectIndexedBoxes(copiedCells[0].audioEffects)
        expect(copiedNested.length).toBe(1)
        expect(UUID.toString(copiedNested[0].address.uuid)).not.toBe(UUID.toString(nested.address.uuid))
        expect(uuidsOf(chainOf(source))).toEqual(uuidsOf([composite]))
        expect(uuidsOf(chainOf(target))).toEqual(uuidsOf([copy]))
        project.terminate()
    })
})

// A new unit dropped between two units names the slot as an index BEFORE the move.
describe("ProjectApi.placeAudioUnit", () => {
    const orderOf = (project: Project) => IndexedBox.collectIndexedBoxes(project.rootBox.audioUnits, AudioUnitBox)
        .filter(box => box.type.getValue() === "instrument")

    it("moves a unit created at the end to the slot", async () => {
        const project = await createProject()
        const {api, editing} = project
        const [first, second, third] = editing.modify(() => [
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox,
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox,
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
        ]).unwrap()
        expect(uuidsOf(orderOf(project))).toEqual(uuidsOf([first, second, third]))
        editing.modify(() => api.placeAudioUnit(third, 1))
        expect(uuidsOf(orderOf(project))).toEqual(uuidsOf([first, third, second]))
        editing.modify(() => api.placeAudioUnit(second, 0))
        expect(uuidsOf(orderOf(project))).toEqual(uuidsOf([second, first, third]))
        expect(orderOf(project).map(box => box.index.getValue())).toEqual([0, 1, 2])
        project.terminate()
    })

    it("places before an anchor unit, and stays put without one or when the anchor is gone", async () => {
        const project = await createProject()
        const {api, editing} = project
        const [first, second, third] = editing.modify(() => [
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox,
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox,
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
        ]).unwrap()
        editing.modify(() => api.placeAudioUnitBefore(third, Option.wrap(first.address.uuid)))
        expect(uuidsOf(orderOf(project))).toEqual(uuidsOf([third, first, second]))
        editing.modify(() => api.placeAudioUnitBefore(third, Option.None))
        expect(uuidsOf(orderOf(project))).toEqual(uuidsOf([third, first, second]))
        // the anchor was deleted while a preset loaded: the new unit keeps the place it was created at
        const gone = second.address.uuid
        editing.modify(() => api.deleteAudioUnit(second))
        const fourth = editing.modify(() => api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox).unwrap()
        editing.modify(() => api.placeAudioUnitBefore(fourth, Option.wrap(gone)))
        expect(uuidsOf(orderOf(project))).toEqual(uuidsOf([third, first, fourth]))
        project.terminate()
    })

    it("leaves the order alone for the unit's own slot and the one after it", async () => {
        const project = await createProject()
        const {api, editing} = project
        const [first, second] = editing.modify(() => [
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox,
            api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox
        ]).unwrap()
        editing.modify(() => api.placeAudioUnit(first, 0))
        editing.modify(() => api.placeAudioUnit(first, 1))
        expect(uuidsOf(orderOf(project))).toEqual(uuidsOf([first, second]))
        project.terminate()
    })
})
