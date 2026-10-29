import {describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, Notifier, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ClipNotification, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {NoteClipBox, NoteEventCollectionBox} from "@opendaw/studio-boxes"
import {PPQN} from "@opendaw/lib-dsp"
import {GroupClipAppearance} from "./GroupClipAppearance"
import {GroupClipLauncher} from "./GroupClipLauncher"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})

const setup = async () => {
    const {Project} = await import("@opendaw/studio-core")
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined,
        sampleManager: {getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record() {}, invalidate() {}, remove() {}, register: () => Terminable.Empty},
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    const products = project.editing.modify(() => [0, 1, 2].map(() => project.api.createAnyInstrument(InstrumentFactories.Neon))).unwrap()
    const [first, second, outside] = products
    const group = project.editing.modify(() => project.grouping.create([first.audioUnitBox, second.audioUnitBox]).unwrap()).unwrap()
    const nested = project.editing.modify(() => project.grouping.create([second.audioUnitBox]).unwrap()).unwrap()
    const clips = project.editing.modify(() => products.map((product, index) => {
        const events = NoteEventCollectionBox.create(project.boxGraph, UUID.generate())
        return NoteClipBox.create(project.boxGraph, UUID.generate(), box => {
            box.clips.refer(product.trackBox.clips)
            box.events.refer(events.owners)
            box.index.setValue(0)
            box.duration.setValue(PPQN.Bar)
            box.hue.setValue(index * 120)
        })
    })).unwrap()
    const playing = new DefaultObservableValue(true)
    const notifications = new Notifier<ClipNotification>()
    vi.spyOn(project.engine, "isPlaying", "get").mockReturnValue(playing)
    vi.spyOn(project.engine, "subscribeClipNotification").mockImplementation(observer => notifications.subscribe(observer))
    const play = vi.spyOn(project.engine, "scheduleClipPlay").mockImplementation(() => {})
    const stop = vi.spyOn(project.engine, "scheduleClipStop").mockImplementation(() => {})
    const launcher = new GroupClipLauncher(project, group)
    return {project, products, first, second, outside, group, nested, clips, playing, notifications, play, stop, launcher}
}

const ids = (values: ReadonlyArray<UUID.Bytes>) => values.map(UUID.toString)

describe("group clip launcher", () => {
    it("launches one column in a single batch, including hidden nested clips and muted clips, excluding outside tracks", async () => {
        const {project, group, nested, clips, play, launcher} = await setup()
        project.editing.modify(() => {group.groupCollapsed.setValue(true); nested.groupCollapsed.setValue(true); clips[1].mute.setValue(true)})
        expect(launcher.clips(0).map(clip => clip.hue)).toEqual([0, 120])
        launcher.toggle(0)
        expect(ids(play.mock.calls[0][0])).toEqual(ids(clips.slice(0, 2).map(clip => clip.address.uuid)))
        launcher.toggle(4)
        expect(play).toHaveBeenCalledTimes(1)
        launcher.terminate()
        project.terminate()
    })
    it("launches group automation with the chosen scene and leaves empty child slots alone", async () => {
        const {project, group, second, play, stop, launcher} = await setup()
        const scene = project.editing.modify(() => {
            const automation = project.api.createAutomationTrack(group, group.volume)
            return [project.api.createValueClip(automation, 1), project.api.createNoteClip(second.trackBox, 1)]
        }).unwrap()
        launcher.toggle(1)
        expect(ids(play.mock.calls[0][0])).toEqual(ids(scene.map(clip => clip.address.uuid)))
        expect(stop).not.toHaveBeenCalled()
        launcher.terminate()
        project.terminate()
    })

    it("follows waiting, playing, canceled and stopped notifications, and stops the group's tracks only", async () => {
        const {project, first, second, clips, notifications, playing, stop, launcher} = await setup()
        notifications.notify({type: "waiting", clips: [clips[2].address.uuid]})
        expect(launcher.state(0)).toBe("idle")
        notifications.notify({type: "waiting", clips: [clips[0].address.uuid]})
        expect(launcher.state(0)).toBe("waiting")
        notifications.notify({type: "sequencing", changes: {started: [clips[0].address.uuid], stopped: [], obsolete: []}})
        expect(launcher.state(0)).toBe("playing")
        launcher.toggle(0)
        expect(ids(stop.mock.calls[0][0])).toEqual(ids([first.trackBox.address.uuid, second.trackBox.address.uuid]))
        notifications.notify({type: "sequencing", changes: {started: [], stopped: [clips[0].address.uuid], obsolete: [clips[2].address.uuid]}})
        expect(launcher.state(0)).toBe("idle")
        notifications.notify({type: "waiting", clips: [clips[1].address.uuid]})
        notifications.notify({type: "sequencing", changes: {started: [], stopped: [], obsolete: [clips[1].address.uuid]}})
        expect(launcher.state(0)).toBe("idle")
        playing.setValue(false)
        expect(launcher.state(0)).toBe("idle")
        launcher.terminate()
        project.terminate()
    })
    it("updates colors and membership after edits, rerouting and undo; releases its listeners", async () => {
        const {project, second, outside, group, clips, launcher} = await setup()
        const changed = vi.fn()
        launcher.subscribe(changed)
        project.editing.modify(() => clips[0].hue.setValue(240))
        expect(changed).toHaveBeenCalled()
        expect(launcher.clips(0).map(clip => clip.hue)).toEqual([240, 120])
        project.editing.modify(() => project.grouping.move([outside.audioUnitBox], group))
        expect(launcher.clips(0)).toHaveLength(3)
        project.editing.modify(() => project.grouping.move([second.audioUnitBox]))
        expect(launcher.clips(0).map(clip => clip.hue)).toEqual([240, 240])
        expect(project.editing.undo()).true
        expect(launcher.clips(0)).toHaveLength(3)
        project.editing.modify(() => clips[0].delete())
        expect(launcher.clips(0)).toHaveLength(2)
        launcher.terminate()
        changed.mockClear()
        project.editing.modify(() => clips[1].hue.setValue(180))
        expect(changed).not.toHaveBeenCalled()
        project.terminate()
    })
    it("starts unnamed and saves independent scene names/colors through reload and duplication", async () => {
        const {project, group, nested, clips, launcher} = await setup()
        expect(GroupClipAppearance.read(group, 0)).toEqual({label: "", hue: 200})
        const updated = vi.fn()
        const subscription = GroupClipAppearance.subscribe(group, 0, updated)
        launcher.rename(0, "Verse")
        launcher.setColor(0, 322)
        expect(updated).toHaveBeenCalled()
        expect(GroupClipAppearance.read(group, 0)).toEqual({label: "Verse", hue: 322})
        expect(GroupClipAppearance.read(nested, 0)).toEqual({label: "", hue: 200})
        expect(GroupClipAppearance.read(group, 1)).toEqual({label: "", hue: 200})
        expect(clips.map(clip => clip.hue.getValue())).toEqual([0, 120, 240])
        const saved = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const restored = saved.boxGraph.findBox(group.address.uuid).unwrap()
        expect(GroupClipAppearance.read(restored as typeof group, 0)).toEqual({label: "Verse", hue: 322})
        const [copy] = project.editing.modify(() => project.grouping.duplicate([group])).unwrap()
        expect(GroupClipAppearance.read(copy, 0)).toEqual({label: "Verse", hue: 322})
        subscription.terminate()
        updated.mockClear()
        launcher.rename(0, "Chorus")
        expect(updated).not.toHaveBeenCalled()
        launcher.terminate()
        project.terminate()
    })
    it("applies mute and trigger loop to the nested column in separate undo steps", async () => {
        const {project, clips, second, launcher} = await setup()
        const nextScene = project.editing.modify(() => project.api.createNoteClip(second.trackBox, 1)).unwrap()
        const outsideLoop = clips[2].triggerMode.loop.getValue()
        launcher.setMuted(0, true)
        expect(launcher.isMuted(0)).true
        expect(clips.map(clip => clip.mute.getValue())).toEqual([true, true, false])
        expect(nextScene.mute.getValue()).false
        launcher.setLooping(0, false)
        expect(launcher.isLooping(0)).false
        expect(clips.slice(0, 2).every(clip => !clip.triggerMode.loop.getValue())).true
        expect(clips[2].triggerMode.loop.getValue()).toBe(outsideLoop)
        expect(project.editing.undo()).true
        expect(launcher.isLooping(0)).true
        expect(launcher.isMuted(0)).true
        expect(project.editing.undo()).true
        expect(launcher.isMuted(0)).false
        launcher.terminate()
        project.terminate()
    })
    it("deletes only the group's column and nested tile metadata, with full undo/redo", async () => {
        const {project, group, nested, clips, second, launcher} = await setup()
        const nextScene = project.editing.modify(() => {
            GroupClipAppearance.store(nested, 0, {label: "Inside", hue: 60})
            return project.api.createNoteClip(second.trackBox, 1)
        }).unwrap()
        launcher.rename(0, "Verse")
        launcher.rename(1, "Chorus")
        launcher.delete(0)
        expect(launcher.clips(0)).toHaveLength(0)
        expect(GroupClipAppearance.read(group, 0).label).toBe("")
        expect(GroupClipAppearance.read(nested, 0).label).toBe("")
        expect(GroupClipAppearance.read(group, 1).label).toBe("Chorus")
        expect(clips[2].isAttached()).true
        expect(nextScene.isAttached()).true
        expect(project.editing.undo()).true
        expect(launcher.clips(0)).toHaveLength(2)
        expect(GroupClipAppearance.read(group, 0).label).toBe("Verse")
        expect(GroupClipAppearance.read(nested, 0).label).toBe("Inside")
        expect(project.editing.redo()).true
        expect(launcher.clips(0)).toHaveLength(0)
        project.boxGraph.verifyPointers()
        launcher.terminate()
        project.terminate()
    })
    it("allows naming and clearing an empty tile without creating clips", async () => {
        const {project, group, launcher} = await setup()
        const update = vi.fn()
        const subscription = GroupClipAppearance.subscribe(group, 4, update)
        launcher.rename(4, "Break")
        launcher.setColor(4, 60)
        expect(launcher.clips(4)).toHaveLength(0)
        expect(GroupClipAppearance.read(group, 4)).toEqual({label: "Break", hue: 60})
        launcher.delete(4)
        expect(GroupClipAppearance.read(group, 4)).toEqual({label: "", hue: 200})
        expect(project.editing.undo()).true
        expect(GroupClipAppearance.read(group, 4)).toEqual({label: "Break", hue: 60})
        expect(update.mock.calls.length).toBeGreaterThan(2)
        subscription.terminate()
        launcher.terminate()
        project.terminate()
    })

})
