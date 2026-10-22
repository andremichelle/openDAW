import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitGroups, AudioUnitBoxAdapter, InstrumentFactories, ProjectSkeleton, DeviceHost, TransferAudioUnits} from "@opendaw/studio-adapters"
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
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}


const setup = async () => {
    const project = await createProject()
    const units = project.editing.modify(() => [0, 1, 2, 3].map(() =>
        project.api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox)).unwrap()
    return {project, units}
}

describe("track folders", () => {
    it("duplicates a child independently without leaving a stale original folder reference", async () => {
        const {project, units: [a]} = await setup()
        project.editing.modify(() => project.grouping.create([a]))
        const [copy] = project.editing.modify(() => TransferAudioUnits.transfer([a], project.skeleton)).unwrap()
        expect(AudioUnitGroups.parent(copy)).toBeUndefined()
        expect(copy.groupParent.targetAddress.isEmpty()).toBe(true)
        expect(copy.output.targetVertex.unwrap().box).toBe(project.primaryAudioBusBox)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("duplicates a top-level track immediately after its source and supports undo/redo", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const [copy] = project.editing.modify(() => project.grouping.duplicate([b])).unwrap()
        expect(AudioUnitGroups.children(project.rootBox)).toEqual([a, b, copy, c, d, project.primaryAudioUnitBox])
        expect(copy.output.targetVertex.unwrap().box).toBe(b.output.targetVertex.unwrap().box)
        project.editing.undo()
        expect(AudioUnitGroups.children(project.rootBox)).toEqual([a, b, c, d, project.primaryAudioUnitBox])
        project.editing.redo()
        const restored = project.boxGraph.findBox(copy.address.uuid).unwrap()
        expect(AudioUnitGroups.children(project.rootBox)).toEqual([a, b, restored, c, d, project.primaryAudioUnitBox])
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("duplicates a child immediately after its source inside the same nested group", async () => {
        const {project, units: [a, b, c]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c])!).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        const [copy] = project.editing.modify(() => project.grouping.duplicate([a])).unwrap()
        expect(AudioUnitGroups.children(project.rootBox, inner)).toEqual([a, copy, b])
        expect(AudioUnitGroups.parent(copy)).toBe(inner)
        expect(copy.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(inner))
        expect(AudioUnitGroups.children(project.rootBox, outer)).toEqual([inner, c])
        const decoded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const loadedCopy = decoded.boxGraph.findBox(copy.address.uuid).unwrap() as typeof copy
        expect(AudioUnitGroups.parent(loadedCopy)?.address.equals(inner.address)).toBe(true)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("duplicates a reversed noncontiguous selection as a block after the last selected sibling", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const [copyA, copyC] = project.editing.modify(() => project.grouping.duplicate([c, a])).unwrap()
        expect(AudioUnitGroups.children(project.rootBox)).toEqual([a, b, c, copyA, copyC, d, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("duplicates nested subtrees only once and places cross-folder selections in their own folders", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c])!).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        const [copyInner, copyC, copyD] = project.editing.modify(() => project.grouping.duplicate([d, a, inner, c])).unwrap()
        expect(AudioUnitGroups.children(project.rootBox, outer)).toEqual([inner, c, copyInner, copyC])
        expect(AudioUnitGroups.children(project.rootBox)).toEqual([outer, d, copyD, project.primaryAudioUnitBox])
        const children = AudioUnitGroups.children(project.rootBox, copyInner)
        expect(children).toHaveLength(2)
        expect(AudioUnitGroups.parent(copyInner)).toBe(outer)
        expect(copyInner.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(outer))
        expect(children.every(child => child.output.targetVertex.unwrap().box === AudioUnitGroups.bus(copyInner))).toBe(true)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("groups selections from different nested folders under their closest common parent", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c, d])!).unwrap()
        const left = project.editing.modify(() => project.grouping.create([a])!).unwrap()
        const right = project.editing.modify(() => project.grouping.create([b])!).unwrap()
        const combined = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        expect(AudioUnitGroups.parent(combined)).toBe(outer)
        expect(AudioUnitGroups.children(project.rootBox, combined)).toEqual([a, b])
        expect(AudioUnitGroups.children(project.rootBox, outer)).toEqual([combined, left, right, c, d])
        expect(AudioUnitGroups.parent(c)).toBe(outer)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("duplicates a nested group with independent children and internal audio routes", async () => {
        const {project, units: [a, b]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        project.editing.modify(() => project.grouping.create([b]))
        const copies = project.editing.modify(() => TransferAudioUnits.transfer([group], project.skeleton)).unwrap()
        const copy = copies[0]
        expect(copy).not.toBe(group)
        expect(copy.isGroup.getValue()).toBe(true)
        const children = AudioUnitGroups.children(project.rootBox, copy)
        expect(children.length).toBe(2)
        expect(children[0].output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(copy))
        const inner = children.find(unit => unit.isGroup.getValue())!
        const leaf = AudioUnitGroups.children(project.rootBox, inner)[0]
        expect(leaf.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(inner))
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("groups at the first selected position, routes through a unity bus, and keeps instruments and clips", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([b, c])!).unwrap()
        expect(AudioUnitGroups.ordered(project.rootBox)).toEqual([a, group, b, c, d, project.primaryAudioUnitBox])
        expect(AudioUnitGroups.children(project.rootBox, group)).toEqual([b, c])
        expect(group.volume.getValue()).toBe(0)
        expect(b.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(group))
        expect(b.input.pointerHub.incoming()[0].box.name).toBe("VaporisateurDeviceBox")
        const adapter = project.boxAdapters.adapterFor(group, AudioUnitBoxAdapter)
        expect(DeviceHost.takesEffect(adapter, "audio")).toBe(true)
        expect(DeviceHost.takesEffect(adapter, "midi")).toBe(false)
        expect(adapter.hostsInstrument).toBe(false)
        const fx = project.editing.modify(() => project.api.insertEffect(group.audioEffects, EffectFactories.AudioNamed.Delay)).unwrap()
        expect(fx.isAttached()).toBe(true)
        project.terminate()
    })
    it("moves into a precise nested slot, moves out, and rejects descendant/feedback cycles", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c])!).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([b])!).unwrap()
        expect(AudioUnitGroups.parent(inner)).toBe(outer)
        expect(inner.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(outer))
        project.editing.modify(() => project.grouping.move([d], inner, b))
        expect(AudioUnitGroups.children(project.rootBox, inner)).toEqual([d, b])
        expect(project.grouping.canMove([outer], inner)).toBe(false)
        expect(project.grouping.canMove([inner], inner)).toBe(false)
        expect(project.grouping.canMove([project.primaryAudioUnitBox], inner)).toBe(false)
        project.editing.modify(() => project.grouping.move([d], undefined, outer))
        expect(AudioUnitGroups.parent(d)).toBeUndefined()
        expect(d.output.targetVertex.unwrap().box).toBe(project.primaryAudioBusBox)
        expect(AudioUnitGroups.ordered(project.rootBox)[0]).toBe(d)
        // independent audio route from the target back to source is rejected too
        project.editing.modify(() => inner.output.refer(AudioUnitGroups.bus(outer)!.input))
        expect(project.grouping.canMove([outer], inner)).toBe(false)
        project.terminate()
    })
    it("moves a selected group and child only once and keeps their subtree contiguous", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        project.editing.modify(() => project.grouping.move([a, group], undefined))
        expect(AudioUnitGroups.ordered(project.rootBox)).toEqual([c, d, group, a, b, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("collapse survives project serialization and never changes audio routes", async () => {
        const {project, units: [a, b]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        project.editing.modify(() => {
            group.groupCollapsed.setValue(true)
            group.userInterface.height.setValue(132)
        })
        expect(AudioUnitGroups.hidden(a)).toBe(true)
        const loaded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const loadedGroup = loaded.boxGraph.findBox(group.address.uuid).unwrap() as typeof group
        const loadedA = loaded.boxGraph.findBox(a.address.uuid).unwrap() as typeof a
        expect(loadedGroup.groupCollapsed.getValue()).toBe(true)
        expect(loadedGroup.userInterface.height.getValue()).toBe(132)
        expect(AudioUnitGroups.parent(loadedA)).toBe(loadedGroup)
        expect(loadedA.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(loadedGroup))
        project.terminate()
    })
    it("deleting a collapsed group removes its full subtree and content, with undo/redo", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([b])!).unwrap()
        const content = project.editing.modify(() => {
            const track = project.boxAdapters.adapterFor(b, AudioUnitBoxAdapter).tracks.values()[0].box
            const clip = project.api.createNoteClip(track, 0)
            const region = project.api.createNoteRegion({trackBox: track, position: 0, duration: 960})
            const effect = project.api.insertEffect(group.audioEffects, EffectFactories.AudioNamed.StereoTool)
            group.groupCollapsed.setValue(true)
            return [track, clip, region, effect]
        }).unwrap()
        const removed = [group, inner, a, b, AudioUnitGroups.bus(group)!, AudioUnitGroups.bus(inner)!, ...content]
            .map(box => box.address.uuid)
        project.editing.modify(() => project.api.deleteAudioUnit(group))
        expect(removed.every(uuid => project.boxGraph.findBox(uuid).isEmpty())).toBe(true)
        expect(AudioUnitGroups.ordered(project.rootBox)).toEqual([c, d, project.primaryAudioUnitBox])
        project.boxGraph.verifyPointers()
        expect(project.editing.undo()).toBe(true)
        expect(removed.every(uuid => project.boxGraph.findBox(uuid).nonEmpty())).toBe(true)
        const restored = project.boxGraph.findBox(group.address.uuid).unwrap() as typeof group
        const restoredInner = project.boxGraph.findBox(inner.address.uuid).unwrap() as typeof inner
        const restoredB = project.boxGraph.findBox(b.address.uuid).unwrap() as typeof b
        expect(restored.groupCollapsed.getValue()).toBe(true)
        expect(AudioUnitGroups.parent(restoredInner)).toBe(restored)
        expect(AudioUnitGroups.parent(restoredB)).toBe(restoredInner)
        expect(restoredB.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(restoredInner))
        project.boxGraph.verifyPointers()
        expect(project.editing.redo()).toBe(true)
        expect(removed.every(uuid => project.boxGraph.findBox(uuid).isEmpty())).toBe(true)
        expect(AudioUnitGroups.ordered(project.rootBox)).toEqual([c, d, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("deleting an inner group preserves its parent, siblings, and outside tracks", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c])!).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        project.editing.modify(() => project.api.deleteAudioUnit(inner))
        expect(AudioUnitGroups.children(project.rootBox, outer)).toEqual([c])
        expect(AudioUnitGroups.ordered(project.rootBox)).toEqual([outer, c, d, project.primaryAudioUnitBox])
        expect([a, b, inner].every(unit => project.boxGraph.findBox(unit.address.uuid).isEmpty())).toBe(true)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("ungroup keeps children and nested groups and supports undo/redo", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([b])!).unwrap()
        project.editing.modify(() => project.grouping.ungroup(group))
        expect(AudioUnitGroups.parent(a)).toBeUndefined()
        expect(AudioUnitGroups.parent(inner)).toBeUndefined()
        expect(AudioUnitGroups.parent(b)).toBe(inner)
        expect(AudioUnitGroups.ordered(project.rootBox)).toEqual([a, inner, b, c, d, project.primaryAudioUnitBox])
        expect(project.editing.undo()).toBe(true)
        const restored = project.boxGraph.findBox(group.address.uuid).unwrap() as typeof group
        expect(AudioUnitGroups.children(project.rootBox, restored).length).toBe(2)
        expect(project.editing.redo()).toBe(true)
        expect(project.boxGraph.findBox(group.address.uuid).isEmpty()).toBe(true)
        project.terminate()
    })
    it("range and toggle selection use visible channel order and clean up deleted tracks", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const selection = project.trackSelection
        const plain = {shiftKey: false, metaKey: false, ctrlKey: false}
        selection.click(a, plain)
        selection.click(c, {...plain, shiftKey: true})
        expect(selection.selected).toEqual([a, b, c])
        selection.click(b, {...plain, metaKey: true})
        expect(selection.selected).toEqual([a, c])
        selection.click(d, {...plain, ctrlKey: true})
        expect(selection.selected).toEqual([a, c, d])
        project.editing.modify(() => project.api.deleteAudioUnit(c))
        expect(selection.selected).toEqual([a, d])
        const group = project.editing.modify(() => project.grouping.create([a, b])!).unwrap()
        project.editing.modify(() => group.groupCollapsed.setValue(true))
        selection.click(group, plain)
        selection.click(d, {...plain, shiftKey: true})
        expect(selection.selected).toEqual([group, d])
        selection.click(d, plain)
        selection.click(d, {...plain, metaKey: true})
        expect(selection.selected).toEqual([])
        expect(selection.hasExplicitSelection).toBe(true)
        project.terminate()
    })
})
