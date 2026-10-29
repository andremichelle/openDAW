import {describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {BoxEditing, IndexedBox} from "@opendaw/lib-box"
import {
    AudioEffectCompositeBoxAdapter, AudioUnitGroups, DeviceHost, Devices, InstrumentFactories, PresetEncoder, PresetHeader, ProjectSkeleton
} from "@opendaw/studio-adapters"
import {AudioEffectCompositeCellBox, AudioUnitBox, InstrumentCompositeBox, InstrumentCompositeCellBox} from "@opendaw/studio-boxes"
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
        const create: DeviceSlot = {type: "new-instrument", insertion: {before: Option.None, parent: Option.None}}
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
            {type: "new-instrument", insertion: project.api.insertionBefore(Option.wrap(next.address.uuid))}, InstrumentFactories.Tubular))
        const order = units()
        expect(order[0]).toBe(first)
        expect(order[2]).toBe(next)
        expect(order.length).toBe(4)
    })

    it.each([false, true])("keeps a captured dialog insertion inside a nested group (last child=%s)", async lastChild => {
        const {project, host} = await setup()
        const first = host.audioUnitBoxAdapter().box
        const second = project.editing.modify(() => project.api.createInstrument(InstrumentFactories.Neon).audioUnitBox).unwrap()
        const outer = project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap()
        const selected = lastChild ? second : first
        project.userEditingManager.audioUnit.edit(selected.editing)
        project.trackSelection.set([])
        const insertion = project.api.insertionAfterEditing()
        project.userEditingManager.audioUnit.edit(outer.editing)
        const instrument = project.editing.modify(() => DeviceSlot.placeInstrument(project,
            {type: "new-instrument", insertion}, InstrumentFactories.Cubed).unwrap()).unwrap()
        const added = instrument.host.targetVertex.unwrap().box as AudioUnitBox
        expect(AudioUnitGroups.children(project.rootBox, inner)).toEqual(lastChild ? [first, second, added] : [first, added, second])
        expect(added.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(inner).unwrap())
        const loaded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const savedAdded = loaded.boxGraph.findBox(added.address.uuid).unwrap() as AudioUnitBox
        expect(UUID.toString(AudioUnitGroups.parent(savedAdded).unwrap().address.uuid)).toBe(UUID.toString(inner.address.uuid))
        project.boxGraph.verifyPointers()
        expect(project.editing.undo()).true
        expect(added.isAttached()).false
        expect(project.editing.redo()).true
        expect(AudioUnitGroups.children(project.rootBox, inner).map(unit => UUID.toString(unit.address.uuid))).toContain(UUID.toString(added.address.uuid))
        project.terminate()
    })

    const rackSetup = async () => {
        const context = await setup()
        const {project, EffectFactories} = context
        const source = project.editing.modify(() => {
            const {audioUnitBox} = project.api.createInstrument(InstrumentFactories.Nano)
            const host = project.boxAdapters.adapterFor(audioUnitBox, Devices.isHost)
            const field = DeviceHost.chainFieldOf(host, "audio").unwrap()
            const compressor = project.api.insertEffect(field, EffectFactories.AudioNamed.Compressor, 0)
            const gate = project.api.insertEffect(field, EffectFactories.AudioNamed.Gate, 1)
            return {audioUnitBox, effects: [compressor, gate]}
        }).unwrap()
        const rack = PresetEncoder.encode(source.audioUnitBox, {}) as ArrayBuffer
        const chain = PresetEncoder.encodeEffects(source.effects, PresetHeader.ChainKind.Audio) as ArrayBuffer
        return {...context, rack, chain}
    }

    it("replaces the whole unit with a rack, effects included", async () => {
        const {project, host, rack, effectNames, instrumentName} = await rackSetup()
        const slot: DeviceSlot = {type: "replace-instrument", host}
        expect(project.editing.modify(() => DeviceSlot.placeRack(project, slot, rack, true)).unwrap()).true
        expect(instrumentName()).toBe("NanoDeviceBox")
        expect(effectNames()).toEqual(["CompressorDeviceBox", "GateDeviceBox"])
    })

    it("creates a new unit from a rack and edits it", async () => {
        const {project, rack, unitCount} = await rackSetup()
        const before = unitCount()
        expect(project.editing.modify(() =>
            DeviceSlot.placeRack(project, {type: "new-instrument", insertion: {before: Option.None, parent: Option.None}}, rack, true)).unwrap()).true
        expect(unitCount()).toBe(before + 1)
        const edited = project.userEditingManager.audioUnit.get().unwrap().box
        const editedHost = project.boxAdapters.adapterFor(edited, Devices.isHost)
        expect(editedHost.inputField.pointerHub.incoming().at(0)?.box.name).toBe("NanoDeviceBox")
    })

    it.each(["rack", "instrument"])("puts a %s preset below the last child and preserves its group route", async kind => {
        const {project, host, rack} = await rackSetup()
        const first = host.audioUnitBoxAdapter().box
        const group = project.editing.modify(() => project.grouping.create([first]).unwrap()).unwrap()
        project.userEditingManager.audioUnit.edit(first.editing)
        const slot: DeviceSlot = {type: "new-instrument", insertion: project.api.insertionAfterEditing()}
        project.editing.modify(() => kind === "rack"
            ? DeviceSlot.placeRack(project, slot, rack, true)
            : DeviceSlot.placePreset(project, slot, rack, "Nano", true))
        const children = AudioUnitGroups.children(project.rootBox, group)
        expect(children.length).toBe(2)
        expect(children[0]).toBe(first)
        expect(children[1].output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(group).unwrap())
        const loaded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const saved = loaded.boxGraph.findBox(children[1].address.uuid).unwrap() as AudioUnitBox
        expect(UUID.toString(AudioUnitGroups.parent(saved).unwrap().address.uuid)).toBe(UUID.toString(group.address.uuid))
        project.boxGraph.verifyPointers()
        project.terminate()
    })

    it("inserts a chain at the slot and replaces one effect with a chain", async () => {
        const {project, host, chain, effectNames} = await rackSetup()
        project.editing.modify(() =>
            DeviceSlot.placePreset(project, {type: "insert", host, accepts: "audio", index: 1}, chain, "", true))
        expect(effectNames()).toEqual(["DelayDeviceBox", "CompressorDeviceBox", "GateDeviceBox", "ReverbDeviceBox"])
        project.editing.modify(() =>
            DeviceSlot.placePreset(project, {type: "replace-effect", host, accepts: "audio", index: 0}, chain, "", true))
        expect(effectNames()).toEqual(["CompressorDeviceBox", "GateDeviceBox", "CompressorDeviceBox", "GateDeviceBox", "ReverbDeviceBox"])
    })

    it("lists racks only where a whole unit can go", async () => {
        const {host} = await setup()
        const replace: DeviceSlot = {type: "replace-instrument", host}
        expect(DeviceSlot.acceptsRack(replace, InstrumentFactories.Nano)).true
        expect(DeviceSlot.acceptsRack(replace, InstrumentFactories.Tape)).false
        expect(DeviceSlot.acceptsRack({type: "new-instrument", insertion: {before: Option.None, parent: Option.None}}, InstrumentFactories.Tape)).true
        expect(DeviceSlot.acceptsRack({type: "insert", host, accepts: "audio", index: 0}, InstrumentFactories.Nano)).false
    })

    it("creates a new instrument unit", async () => {
        const {project, unitCount} = await setup()
        const before = unitCount()
        project.editing.modify(() => DeviceSlot.placeInstrument(project, {type: "new-instrument", insertion: {before: Option.None, parent: Option.None}},
            InstrumentFactories.Nano))
        expect(unitCount()).toBe(before + 1)
    })
    const layerSetup = async () => {
        const context = await rackSetup()
        const {project} = context
        const composite = project.editing.modify(() =>
            project.api.createInstrument(InstrumentFactories.InstrumentComposite).instrumentBox as InstrumentCompositeBox).unwrap()
        const compositeHost = project.boxAdapters.adapterFor(composite.host.targetVertex.unwrap().box, Devices.isHost)
        const slot: DeviceSlot = {type: "new-layer", host: compositeHost, composite}
        const layerNames = (): ReadonlyArray<string> => IndexedBox.collectIndexedBoxes(composite.cells, InstrumentCompositeCellBox)
            .map(cell => cell.instrument.pointerHub.incoming().at(0)?.box.name ?? "none")
        return {...context, slot, layerNames}
    }

    it("lists every note instrument for a new layer and no racks", async () => {
        const {slot} = await layerSetup()
        expect(DeviceSlot.categoryOf(slot)).toBe("instrument")
        expect(DeviceSlot.takesNotes(slot)).true
        expect(DeviceSlot.isReplace(slot)).false
        expect(DeviceSlot.acceptsInstrument(slot, InstrumentFactories.Nano)).true
        expect(DeviceSlot.acceptsInstrument(slot, InstrumentFactories.InstrumentComposite)).true
        expect(DeviceSlot.acceptsInstrument(slot, InstrumentFactories.Tape)).false
        expect(DeviceSlot.acceptsInstrument(slot, InstrumentFactories.MIDIOutput)).true
        expect(DeviceSlot.acceptsRack(slot, InstrumentFactories.Nano)).false
        expect(DeviceSlot.hasTimeline(slot)).false
    })

    it("appends a layer with a stock instrument", async () => {
        const {project, slot, layerNames} = await layerSetup()
        project.editing.modify(() => DeviceSlot.placeInstrument(project, slot, InstrumentFactories.Nano))
        project.editing.modify(() => DeviceSlot.placeInstrument(project, slot, InstrumentFactories.Vaporisateur))
        expect(layerNames()).toEqual(["NanoDeviceBox", "VaporisateurDeviceBox"])
    })

    it("appends a layer from an instrument preset, a misfit leaves no layer behind", async () => {
        const {project, slot, rack, chain, layerNames} = await layerSetup()
        expect(project.editing.modify(() => DeviceSlot.placePreset(project, slot, rack, "Nano", true)).unwrap()).true
        expect(layerNames()).toEqual(["NanoDeviceBox"])
        expect(project.editing.modify(() => DeviceSlot.placePreset(project, slot, rack, "Unknown", true)).unwrap()).false
        expect(layerNames()).toEqual(["NanoDeviceBox"])
        project.editing.modify(() => DeviceSlot.placePreset(project, slot, chain, "Nano", true))
        expect(layerNames().length).toBe(2)
    })

    const entrySetup = async () => {
        const context = await rackSetup()
        const {project, EffectFactories, host, audioField} = context
        const box = project.editing.modify(() =>
            project.api.insertEffect(audioField, EffectFactories.AudioNamed.AudioEffectComposite, 2)).unwrap()
        const composite = project.boxAdapters.adapterFor(box, AudioEffectCompositeBoxAdapter)
        const slot: DeviceSlot = {type: "new-entry", host, composite}
        const entryNames = (): ReadonlyArray<ReadonlyArray<string>> =>
            IndexedBox.collectIndexedBoxes(composite.box.entries, AudioEffectCompositeCellBox)
                .map(cell => IndexedBox.collectIndexedBoxes(cell.audioEffects).map(effect => effect.name))
        return {...context, slot, entryNames}
    }

    it("appends an FX Composite entry holding the effect", async () => {
        const {project, EffectFactories, slot, entryNames, effectNames} = await entrySetup()
        expect(DeviceSlot.categoryOf(slot)).toBe("audio-effect")
        expect(DeviceSlot.isReplace(slot)).false
        project.editing.modify(() => DeviceSlot.placeEffect(slot, (field, index) =>
            project.api.insertEffect(field, EffectFactories.AudioNamed.Compressor, index)))
        project.editing.modify(() => DeviceSlot.placeEffect(slot, (field, index) =>
            project.api.insertEffect(field, EffectFactories.AudioNamed.Delay, index)))
        expect(entryNames()).toEqual([["CompressorDeviceBox"], ["DelayDeviceBox"]])
        expect(effectNames(), "the outer chain is untouched").toEqual(["DelayDeviceBox", "ReverbDeviceBox", "AudioEffectCompositeBox"])
    })

    it("appends an FX Composite entry from a chain preset, a misfit leaves no entry behind", async () => {
        const {project, slot, chain, entryNames} = await entrySetup()
        expect(project.editing.modify(() => DeviceSlot.placePreset(project, slot, chain, "", true)).unwrap()).true
        expect(entryNames()).toEqual([["CompressorDeviceBox", "GateDeviceBox"]])
        const garbage = new Uint8Array(16).buffer
        expect(project.editing.modify(() => DeviceSlot.placePreset(project, slot, garbage, "", true)).unwrap()).false
        expect(entryNames()).toEqual([["CompressorDeviceBox", "GateDeviceBox"]])
    })
})

describe("DeviceAudition", () => {
    const entryOf = (key: string, apply: (project: Project, slot: DeviceSlot) => boolean): DeviceEntry => {
        const candidate: DeviceCandidate = {
            offersTimeline: false, apply: (project, slot) => apply(project, slot), settle: () => Promise.resolve()
        }
        return {
            key, kind: "device", local: false, name: key, brief: "", caption: "", description: "", icon: 0,
            iconUrl: Option.None, deviceKey: key, facts: [], tags: [], preset: Option.None, bundle: Option.None,
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
