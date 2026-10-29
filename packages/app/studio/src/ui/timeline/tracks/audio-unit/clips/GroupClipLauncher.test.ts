import {describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, Notifier, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ClipNotification, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {NoteClipBox, NoteEventCollectionBox} from "@opendaw/studio-boxes"
import {PPQN} from "@opendaw/lib-dsp"
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
})
