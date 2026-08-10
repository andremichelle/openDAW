import {describe, expect, it} from "vitest"
import {DefaultObservableValue, isDefined, isNull, Nullable, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AnyClipBoxAdapter, AudioClipBoxAdapter, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {AudioClipBox, AudioFileBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"

// Live error 1094. A ClipLane cell can display a clip belonging to ANOTHER track (populatePlaceholder borrows
// through `strategy.translateTrackIndex` while a move runs), but the lane subscribes to its OWN clip
// collection only. So a foreign clip's deletion never reached the cell, it kept the dead adapter until the
// deferred rebuild a frame later, and the painter rendered it — reading a file pointer the deletion had
// already disconnected. The cell now follows the box it displays, which is what this pins.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

// The cell wiring of `ClipLane.restockPlaceholders`, isolated from the DOM.
const cellFollowingItsClip = (lifecycle: Terminator) => {
    const cell = new DefaultObservableValue<Nullable<AnyClipBoxAdapter>>(null)
    const deletion = lifecycle.own(new Terminator())
    lifecycle.own(cell.catchupAndSubscribe(owner => {
        deletion.terminate()
        const displayed = owner.getValue()
        if (isNull(displayed)) {return}
        deletion.own(displayed.box.subscribeDeletion(() => cell.setValue(null)))
    }))
    return cell
}

describe("a clip cell must not outlive the clip it displays (1094)", () => {
    it("clears itself when the displayed clip is deleted, whichever track owns it", async () => {
        const {Project} = await import("@opendaw/studio-core")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
            box.fileName.setValue("cell.wav")
            box.endInSeconds.setValue(4.0)
        })
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        const clipBox = AudioClipBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(0)
            box.duration.setValue(PPQN.Bar)
            box.clips.refer(trackBox.clips)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton({
            audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
            soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
        } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
        const lifecycle = new Terminator()
        const cell = cellFollowingItsClip(lifecycle)
        cell.setValue(project.boxAdapters.adapterFor(clipBox, AudioClipBoxAdapter))
        expect(cell.getValue()).not.toBeNull()
        boxGraph.beginTransaction()
        clipBox.delete()
        boxGraph.endTransaction()
        // Cleared IN the deleting transaction, so no animation frame can paint the dead clip.
        expect(cell.getValue()).toBeNull()
        lifecycle.terminate()
    })
})
