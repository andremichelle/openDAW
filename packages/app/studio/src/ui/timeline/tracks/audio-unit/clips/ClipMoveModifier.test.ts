import {expect, it} from "vitest"
import {DefaultObservableValue, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {NoteClipBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {ClipsView} from "@/ui/timeline/ClipsView"
import {ClipMoveModifier} from "./ClipMoveModifier"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

it("replaces an occupied column on move and restores both clips with one undo", async () => {
    const {Project} = await import("@opendaw/studio-core")
    const sampleManager = {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record() {}, invalidate() {}, remove() {}, register: () => Terminable.Empty
    }
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton({audioContext: undefined, audioWorklets: undefined, sampleManager,
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined} as unknown as
        Parameters<typeof Project.fromSkeleton>[0], skeleton)
    const {source, destination, track} = project.editing.modify(() => {
        const track = TrackBox.create(project.boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.tracks.refer(skeleton.mandatoryBoxes.primaryAudioUnitBox.tracks)
            box.target.refer(skeleton.mandatoryBoxes.primaryAudioUnitBox)
        })
        return {track, source: project.api.createNoteClip(track, 0), destination: project.api.createNoteClip(track, 15)}
    }).unwrap()
    const trackBoxAdapter = project.boxAdapters.adapterFor(track, TrackBoxAdapter)
    trackBoxAdapter.listIndex = 0
    const sourceAdapter = project.boxAdapters.adapterFor(source, NoteClipBoxAdapter)
    const context = {trackBoxAdapter}
    const clips = new ClipsView(new DefaultObservableValue(true))
    clips.reset(15)
    const manager = {tracks: () => [context], numTracks: () => 1, getByIndex: () => Option.wrap(context)}
    const axis = {axisToValue: (value: number) => value, valueToAxis: (value: number) => value}
    const modifier = ClipMoveModifier.start({project, clips, xAxis: axis, yAxis: axis,
        pointerClipIndex: 0, pointerTrackIndex: 0, manager, selection: {selected: () => [sourceAdapter]}} as unknown as
        Parameters<typeof ClipMoveModifier.start>[0]).unwrap()
    modifier.update({clientX: 15, clientY: 0, altKey: false, shiftKey: false, ctrlKey: false})
    modifier.approve()
    expect(source.index.getValue()).toBe(15)
    expect(project.boxGraph.findBox(destination.address.uuid).isEmpty()).toBe(true)
    expect(trackBoxAdapter.clips.collection.adapters()).toHaveLength(1)
    expect(clips.columns.getValue()).toBe(17)
    project.editing.undo()
    expect(source.index.getValue()).toBe(0)
    expect(trackBoxAdapter.clips.collection.adapters()).toHaveLength(2)
    expect(trackBoxAdapter.clips.collection.getAdapterByIndex(0).unwrap().uuid).toEqual(source.address.uuid)
    expect(trackBoxAdapter.clips.collection.getAdapterByIndex(15).unwrap().uuid).toEqual(destination.address.uuid)
    project.terminate()
})
