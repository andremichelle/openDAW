import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    AudioUnitBoxAdapter,
    NoteRegionBoxAdapter,
    ProjectSkeleton,
    TrackType,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {TimelineLabels} from "@/ui/timeline/TimelineLabels"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

// `resolvable: false` puts the value region on a track that no longer reports itself as a value track, which is
// how a stale automation region presents itself when its track can no longer name a parameter.
const setup = async (resolvable: boolean) => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const valueTrack = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(resolvable ? TrackType.Value : TrackType.Undefined)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox.volume)
    })
    const noteTrack = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.index.setValue(1)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, skeleton)
    project.boxAdapters.adapterFor(primaryAudioUnitBox, AudioUnitBoxAdapter)
    const valueRegion = (label: string): ValueRegionBoxAdapter => project.editing.modify(() => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.duration.setValue(1920)
            box.loopDuration.setValue(1920)
            box.events.refer(events.owners)
            box.regions.refer(valueTrack.regions)
        })
    }).map(box => project.boxAdapters.adapterFor(box, ValueRegionBoxAdapter)).unwrap("value-region")
    const noteRegion = (label: string): NoteRegionBoxAdapter => project.editing.modify(() => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        return NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.duration.setValue(1920)
            box.loopDuration.setValue(1920)
            box.events.refer(events.owners)
            box.regions.refer(noteTrack.regions)
        })
    }).map(box => project.boxAdapters.adapterFor(box, NoteRegionBoxAdapter)).unwrap("note-region")
    return {valueRegion, noteRegion}
}

describe("TimelineLabels.forRegion", () => {
    it("shows the automated parameter name when the region carries no custom label", async () => {
        const {valueRegion} = await setup(true)
        expect(TimelineLabels.forRegion(valueRegion(""))).toBe("Volume")
    })

    it("appends a custom label behind the parameter name", async () => {
        const {valueRegion} = await setup(true)
        expect(TimelineLabels.forRegion(valueRegion("Build-up"))).toBe("Volume · Build-up")
    })

    it("never repeats the parameter name, whatever recorded automation stored", async () => {
        const {valueRegion} = await setup(true)
        expect(TimelineLabels.forRegion(valueRegion("volume"))).toBe("Volume")
        expect(TimelineLabels.forRegion(valueRegion("Volume"))).toBe("Volume")
        expect(TimelineLabels.forRegion(valueRegion("  volume  "))).toBe("Volume")
    })

    it("falls back to N/A when the parameter cannot be resolved", async () => {
        const {valueRegion} = await setup(false)
        expect(TimelineLabels.forRegion(valueRegion(""))).toBe("N/A")
        expect(TimelineLabels.forRegion(valueRegion("Build-up"))).toBe("N/A · Build-up")
    })

    it("leaves an unlabelled note region empty and never composes it", async () => {
        const {noteRegion} = await setup(true)
        expect(TimelineLabels.forRegion(noteRegion(""))).toBe("")
        expect(TimelineLabels.forRegion(noteRegion("Verse"))).toBe("Verse")
    })
})
