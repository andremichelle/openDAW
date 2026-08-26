import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {
    AnyRegionBoxAdapter,
    AudioRegionBoxAdapter,
    ProjectSkeleton,
    TrackType
} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {RegionModifierSelection} from "./RegionModifierSelection"

// Live error 1095. A region drag was in flight when the user pressed Delete and then Undo: the modifier still
// holds the ORPHANED adapter, and `Box.isAttached()` is uuid-based, so it answers true for it once undo has
// re-created the region under the same uuid. `RegionClipResolver.fromSelection` then hard-unwraps the orphan's
// `trackBoxAdapter` and the session crashes.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const buildOrphanedRegion = async () => {
    // studio-core is imported HERE, after the AudioWorkletNode stub above: its barrel pulls
    // EngineWorklet, which extends AudioWorkletNode at class-definition time.
    const {Project, RegionClipResolver, RegionModifyStrategies} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    const regionUUID = UUID.generate()
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.fileName.setValue("orphan.wav")
        box.endInSeconds.setValue(4.0)
    })
    const createRegion = () => {
        // Boxes cannot be created inside another box's constructor lambda (see BoxGraph.stageBox).
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioRegionBox.create(boxGraph, regionUUID, box => {
            box.position.setValue(0)
            box.duration.setValue(PPQN.Bar)
            box.loopDuration.setValue(PPQN.Bar)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
    }
    const regionBox = createRegion()
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    const captured: AnyRegionBoxAdapter = project.boxAdapters.adapterFor(regionBox, AudioRegionBoxAdapter)
    // The drag is running: Delete, then Undo — which re-creates the region under the SAME uuid, leaving the
    // modifier holding the previous instance.
    boxGraph.beginTransaction()
    regionBox.delete()
    boxGraph.endTransaction()
    boxGraph.beginTransaction()
    createRegion()
    boxGraph.endTransaction()
    // The region the undo re-created: what the user is actually looking at.
    const live: AnyRegionBoxAdapter = project.boxAdapters
        .adapterFor(boxGraph.findBox(regionUUID).unwrap("re-created region").asBox(AudioRegionBox),
            AudioRegionBoxAdapter)
    return {project, captured, live, RegionClipResolver, RegionModifyStrategies}
}

describe("a region modifier must drop what its drag outlived (1095)", () => {
    it("an orphaned adapter still reports isAttached, so that guard cannot be the filter", async () => {
        const {captured} = await buildOrphanedRegion()
        expect(captured.box.isAttached()).toBe(true)
        expect(captured.trackBoxAdapter.isEmpty()).toBe(true)
    })

    it("handing the orphan to the overlap resolver is what threw", async () => {
        const {captured, RegionClipResolver, RegionModifyStrategies} = await buildOrphanedRegion()
        expect(() => RegionClipResolver.fromSelection([], [captured], RegionModifyStrategies.Identity, 0))
            .toThrowError("trackBoxAdapter")
    })

    it("the check every modifier runs before applying reports it, so the drag is abandoned", async () => {
        const {captured} = await buildOrphanedRegion()
        expect(RegionModifierSelection.isIntact([captured])).toBe(false)
    })

    it("an untouched selection stays intact, so an ordinary drag still applies", async () => {
        const {live} = await buildOrphanedRegion()
        expect(RegionModifierSelection.isIntact([live])).toBe(true)
        expect(RegionModifierSelection.tracksOf([live])).toHaveLength(1)
    })
})
