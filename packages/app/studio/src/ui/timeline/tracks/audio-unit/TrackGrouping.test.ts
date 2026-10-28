import {describe, expect, it, vi} from "vitest"
import {asInstanceOf, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Key, Shortcut, ShortcutDefinitions} from "@opendaw/lib-dom"
import {AudioUnitGroups, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ShortcutStorage, ShortcutStore} from "@/service/ShortcutStorage"
import {GlobalShortcutsFactory} from "@/ui/shortcuts/GlobalShortcuts"
import {ungroupSelectedTracks} from "./TrackGrouping"

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
    const {Project} = await import("@opendaw/studio-core")
    return Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0],
    ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

describe("ungroup command", () => {
    it("ungroups selected nested groups together, selects promoted tracks and undoes in one step", async () => {
        const project = await setup()
        const [first, second] = project.editing.modify(() => [0, 1].map(() =>
            project.api.createAnyInstrument(InstrumentFactories.Neon).audioUnitBox)).unwrap()
        const outer = project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([first]).unwrap()).unwrap()
        project.trackSelection.set([outer, inner])
        ungroupSelectedTracks(project)
        expect(outer.isAttached()).toBe(false)
        expect(inner.isAttached()).toBe(false)
        expect(project.trackSelection.selected).toEqual([first, second])
        expect(AudioUnitGroups.parent(first).isEmpty()).toBe(true)
        expect(first.output.targetVertex.unwrap().box).toBe(project.primaryAudioBusBox)
        expect(project.editing.undo()).toBe(true)
        const restoredInner = asInstanceOf(project.boxGraph.findBox(inner.address.uuid).unwrap(), AudioUnitBox)
        expect(AudioUnitGroups.parent(first).unwrap().address.equals(inner.address)).toBe(true)
        expect(AudioUnitGroups.parent(restoredInner).unwrap().address.equals(outer.address)).toBe(true)
        expect(AudioUnitGroups.parent(second).unwrap().address.equals(outer.address)).toBe(true)
        expect(project.editing.redo()).toBe(true)
        expect(project.boxGraph.findBox(inner.address.uuid).isEmpty()).toBe(true)
        expect(project.boxGraph.findBox(outer.address.uuid).isEmpty()).toBe(true)
        expect(AudioUnitGroups.parent(first).isEmpty()).toBe(true)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("uses the edited group with empty selection and ignores ordinary tracks", async () => {
        const project = await setup()
        const track = project.editing.modify(() => project.api.createAnyInstrument(InstrumentFactories.Neon).audioUnitBox).unwrap()
        project.trackSelection.set([track])
        ungroupSelectedTracks(project)
        expect(track.isAttached()).toBe(true)
        const group = project.editing.modify(() => project.grouping.create([track]).unwrap()).unwrap()
        project.trackSelection.set([])
        project.userEditingManager.audioUnit.edit(group.editing)
        ungroupSelectedTracks(project)
        expect(group.isAttached()).toBe(false)
        expect(project.trackSelection.selected).toEqual([track])
        project.terminate()
    })
    it("migrates saved group shortcuts through upstream custom-only shortcut storage", () => {
        const customGroup = Shortcut.of(Key.KeyG, {ctrl: true, alt: true})
        const customUngroup = Shortcut.of(Key.KeyU, {ctrl: true, shift: true})
        const values = new Map<string, string>([[ShortcutStorage.LegacyStorageKey, JSON.stringify({global: {
            "group-tracks": customGroup.toJSON(), "ungroup-tracks": customUngroup.toJSON(),
            "workspace-screen-piano": Shortcut.of(Key.Digit3, {shift: true}).toJSON()
        }})]])
        const storage: ShortcutStore = {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => {values.set(key, value)},
            removeItem: key => {values.delete(key)}
        }
        const contexts = {global: {factory: GlobalShortcutsFactory, workingDefinition: ShortcutDefinitions.copy(GlobalShortcutsFactory)}}
        expect(ShortcutStorage.load(contexts, storage)).toBe(true)
        expect(contexts.global.workingDefinition["group-tracks"].shortcut.equals(customGroup)).toBe(true)
        expect(contexts.global.workingDefinition["ungroup-tracks"].shortcut.equals(customUngroup)).toBe(true)
        expect(contexts.global.workingDefinition["workspace-screen-piano"].shortcut
            .equals(GlobalShortcutsFactory["workspace-screen-piano"].shortcut)).toBe(true)
        expect(values.has(ShortcutStorage.LegacyStorageKey)).toBe(false)
        const stored = JSON.parse(values.get(ShortcutStorage.StorageKey) ?? "{}")
        expect(Object.keys(stored.global).sort()).toEqual(["group-tracks", "ungroup-tracks"])
        const restored = {global: {factory: GlobalShortcutsFactory, workingDefinition: ShortcutDefinitions.copy(GlobalShortcutsFactory)}}
        expect(ShortcutStorage.load(restored, storage)).toBe(true)
        expect(restored.global.workingDefinition["ungroup-tracks"].shortcut.equals(customUngroup)).toBe(true)
    })
    it("keeps old shortcut preferences and persists a remapped ungroup action independently", () => {
        const shortcuts = ShortcutDefinitions.copy(GlobalShortcutsFactory)
        const customGroup = Shortcut.of(Key.KeyG, {ctrl: true, alt: true})
        ShortcutDefinitions.fromJSON(shortcuts, {"group-tracks": customGroup.toJSON()})
        expect(shortcuts["group-tracks"].shortcut.equals(customGroup)).toBe(true)
        expect(shortcuts["ungroup-tracks"].shortcut.equals(Shortcut.of(Key.KeyG, {ctrl: true, shift: true}))).toBe(true)
        const customUngroup = Shortcut.of(Key.KeyU, {ctrl: true, shift: true})
        shortcuts["ungroup-tracks"].shortcut.overrideWith(customUngroup)
        const restored = ShortcutDefinitions.copy(GlobalShortcutsFactory)
        ShortcutDefinitions.fromJSON(restored, JSON.parse(JSON.stringify(ShortcutDefinitions.toJSON(shortcuts))))
        expect(restored["ungroup-tracks"].shortcut.equals(customUngroup)).toBe(true)
        expect(restored["group-tracks"].shortcut.equals(customGroup)).toBe(true)
    })
})
