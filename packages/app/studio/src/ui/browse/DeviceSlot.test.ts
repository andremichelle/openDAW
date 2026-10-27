import {describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {BoxEditing, IndexedBox} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"
import {DeviceSlot} from "./DeviceSlot"
import {DeviceAudition} from "./DeviceAudition"
import type {DeviceCandidate, DeviceEntry} from "./DeviceCatalog"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const setup = async () => {
    const {Project, EffectFactories} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project: Project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, skeleton)
    const {audioUnitBox} = project.editing.modify(() =>
        project.api.createInstrument(InstrumentFactories.Vaporisateur)).unwrap()
    const host = project.boxAdapters.adapterFor(audioUnitBox, Devices.isHost)
    const audioField = DeviceHost.chainFieldOf(host, "audio").unwrap()
    project.editing.modify(() => {
        project.api.insertEffect(audioField, EffectFactories.AudioNamed.Delay, 0)
        project.api.insertEffect(audioField, EffectFactories.AudioNamed.Reverb, 1)
    })
    const effectNames = (): ReadonlyArray<string> =>
        IndexedBox.collectIndexedBoxes(audioField).map(box => box.name)
    const instrumentName = (): string => host.inputField.pointerHub.incoming().at(0)?.box.name ?? "none"
    const unitCount = (): number => IndexedBox.collectIndexedBoxes(project.rootBox.audioUnits, AudioUnitBox).length
    const editing = project.editing as BoxEditing
    return {project, EffectFactories, host, audioField, effectNames, instrumentName, unitCount, editing}
}

describe("DeviceSlot", () => {
    it("inserts an effect between two effects", async () => {
        const {project, EffectFactories, host, effectNames} = await setup()
        const slot: DeviceSlot = {type: "insert", host, accepts: "audio", index: 1}
        project.editing.modify(() => DeviceSlot.placeEffect(slot, (field, index) =>
            project.api.insertEffect(field, EffectFactories.AudioNamed.Compressor, index)))
        expect(effectNames()).toEqual(["DelayDeviceBox", "CompressorDeviceBox", "ReverbDeviceBox"])
    })

    it("replaces an effect at its index", async () => {
        const {project, EffectFactories, host, effectNames} = await setup()
        const slot: DeviceSlot = {type: "replace-effect", host, accepts: "audio", index: 0}
        expect(DeviceSlot.currentDeviceKey(slot).unwrap()).toBe("Delay")
        project.editing.modify(() => DeviceSlot.placeEffect(slot, (field, index) =>
            project.api.insertEffect(field, EffectFactories.AudioNamed.Compressor, index)))
        expect(effectNames()).toEqual(["CompressorDeviceBox", "ReverbDeviceBox"])
    })

    it("replaces the instrument and keeps the effects", async () => {
        const {project, host, effectNames, instrumentName} = await setup()
        const slot: DeviceSlot = {type: "replace-instrument", host}
        expect(DeviceSlot.currentDeviceKey(slot).unwrap()).toBe("Vaporisateur")
        project.editing.modify(() => DeviceSlot.placeInstrument(project, slot, InstrumentFactories.Nano))
        expect(instrumentName()).toBe("NanoDeviceBox")
        expect(effectNames()).toEqual(["DelayDeviceBox", "ReverbDeviceBox"])
    })

    it("lists what can take an instrument's place", async () => {
        const {host} = await setup()
        const replace: DeviceSlot = {type: "replace-instrument", host}
        const create: DeviceSlot = {type: "new-instrument", anchor: Option.None}
        expect(DeviceSlot.acceptsInstrument(replace, InstrumentFactories.Nano)).true
        expect(DeviceSlot.acceptsInstrument(replace, InstrumentFactories.Tape)).false
        expect(DeviceSlot.acceptsInstrument(replace, InstrumentFactories.InstrumentComposite)).false
        expect(DeviceSlot.acceptsInstrument(create, InstrumentFactories.Tape)).false
        expect(DeviceSlot.acceptsInstrument(create, InstrumentFactories.InstrumentComposite)).true
        expect(DeviceSlot.canReplaceInstrument(host)).true
    })

    it("places a new instrument right below the unit in edit mode", async () => {
        const {project} = await setup()
        const next = project.editing.modify(() => project.api.createInstrument(InstrumentFactories.Nano).audioUnitBox).unwrap()
        const units = () => IndexedBox.collectIndexedBoxes(project.rootBox.audioUnits, AudioUnitBox)
        const first = units()[0]
        project.editing.modify(() => DeviceSlot.placeInstrument(project,
            {type: "new-instrument", anchor: Option.wrap(next.address.uuid)}, InstrumentFactories.Tubular))
        const order = units()
        expect(order[0]).toBe(first)
        expect(order[2]).toBe(next)
        expect(order.length).toBe(4)
    })

    it("creates a new instrument unit", async () => {
        const {project, unitCount} = await setup()
        const before = unitCount()
        project.editing.modify(() => DeviceSlot.placeInstrument(project, {type: "new-instrument", anchor: Option.None},
            InstrumentFactories.Nano))
        expect(unitCount()).toBe(before + 1)
    })
})

describe("DeviceAudition", () => {
    const entryOf = (key: string, apply: (project: Project, slot: DeviceSlot) => boolean): DeviceEntry => {
        const candidate: DeviceCandidate = {
            offersTimeline: false, apply: (project, slot) => apply(project, slot), settle: () => Promise.resolve()
        }
        return {
            key, kind: "device", local: false, name: key, brief: "", caption: "", description: "", icon: 0,
            iconUrl: Option.None, deviceKey: key, facts: [], tags: [], preset: Option.None,
            prepare: () => Promise.resolve(candidate)
        } as DeviceEntry
    }

    const auditionSetup = async () => {
        const context = await setup()
        const {project, EffectFactories} = context
        const effect = (factory: typeof EffectFactories.AudioNamed.Compressor) => (project: Project, slot: DeviceSlot) =>
            DeviceSlot.placeEffect(slot, (field, index) => project.api.insertEffect(field, factory, index)).nonEmpty()
        const compressor = entryOf("Compressor", effect(EffectFactories.AudioNamed.Compressor))
        const gate = entryOf("Gate", effect(EffectFactories.AudioNamed.Gate))
        const service = {project} as unknown as StudioService
        return {...context, compressor, gate, service}
    }

    const settled = () => new Promise(resolve => setTimeout(resolve, 0))

    it("keeps only the last pick", async () => {
        const {service, host, compressor, gate, effectNames} = await auditionSetup()
        const audition = new DeviceAudition(service, {type: "replace-effect", host, accepts: "audio", index: 1})
        audition.pick(compressor)
        await settled()
        expect(effectNames()).toEqual(["DelayDeviceBox", "CompressorDeviceBox"])
        audition.pick(gate)
        await settled()
        expect(effectNames()).toEqual(["DelayDeviceBox", "GateDeviceBox"])
        audition.cancel()
    })

    it("reverts everything on cancel", async () => {
        const {service, host, compressor, gate, effectNames, editing} = await auditionSetup()
        const audition = new DeviceAudition(service, {type: "insert", host, accepts: "audio", index: 0})
        audition.pick(compressor)
        await settled()
        audition.pick(gate)
        await settled()
        audition.cancel()
        expect(effectNames()).toEqual(["DelayDeviceBox", "ReverbDeviceBox"])
        expect(editing.canRedo()).false
    })

    it("approves the last pick as one undo step", async () => {
        const {service, host, compressor, gate, effectNames, editing} = await auditionSetup()
        const audition = new DeviceAudition(service, {type: "insert", host, accepts: "audio", index: 2})
        audition.pick(compressor)
        await settled()
        audition.pick(gate)
        await audition.approve()
        expect(effectNames()).toEqual(["DelayDeviceBox", "ReverbDeviceBox", "GateDeviceBox"])
        editing.undo()
        expect(effectNames()).toEqual(["DelayDeviceBox", "ReverbDeviceBox"])
        editing.redo()
        expect(effectNames()).toEqual(["DelayDeviceBox", "ReverbDeviceBox", "GateDeviceBox"])
    })

    it("ignores a pick that finishes loading after a newer one", async () => {
        const {service, host, compressor, gate, effectNames} = await auditionSetup()
        const slow: DeviceEntry = {...compressor, key: "slow", prepare: () => new Promise(resolve =>
            setTimeout(() => compressor.prepare().then(resolve), 20))}
        const audition = new DeviceAudition(service, {type: "insert", host, accepts: "audio", index: 0})
        audition.pick(slow)
        audition.pick(gate)
        await new Promise(resolve => setTimeout(resolve, 40))
        expect(effectNames()).toEqual(["GateDeviceBox", "DelayDeviceBox", "ReverbDeviceBox"])
        audition.cancel()
    })
})
