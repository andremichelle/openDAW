import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, Grooves, ProjectSkeleton, SampleMetaData, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, TransientMarkerBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {AudioContentModifier} from "./AudioContentModifier"
import type {ProjectEnv} from "../ProjectEnv"

// Audio regions take a groove like regions with notes, except No Sync audio, which is not on the grid.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const AUDIO_SECONDS = 2.0

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, soundfontManager: undefined,
    sampleService: undefined, soundfontService: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get meta() {return Option.wrap<SampleMetaData>({name: "loop.wav", bpm: 120, duration: AUDIO_SECONDS, sample_rate: 48000, origin: "import"})},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    }
}) as unknown as ProjectEnv

const setup = async () => {
    const {Project} = await import("../Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.fileName.setValue("loop.wav")
        box.endInSeconds.setValue(AUDIO_SECONDS)
    })
    // known transients, so Grain needs no detection worker
    TransientMarkerBox.create(boxGraph, UUID.generate(), box => box.owner.refer(audioFileBox.transientMarkers))
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(AUDIO_SECONDS)
        box.loopDuration.setValue(AUDIO_SECONDS)
        box.timeBase.setValue(TimeBase.Seconds)
        box.regions.refer(trackBox.regions)
        box.file.refer(audioFileBox)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const adapter = project.boxAdapters.adapterFor(regionBox, AudioRegionBoxAdapter)
    const groove = project.editing.modify(() => Grooves.create(project, "power")).unwrap()
    return {project, adapter, groove}
}

describe("audio grooves", () => {
    it("Pitch and Grain audio accept a groove so far, No Sync never", async () => {
        const {project, adapter} = await setup()
        expect(Grooves.acceptsGroove(adapter.box), "No Sync").toBe(false)
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        expect(Grooves.acceptsGroove(adapter.box), "Pitch").toBe(true)
        project.editing.modify(await AudioContentModifier.toTimeStretch([adapter]))
        expect(Grooves.acceptsGroove(adapter.box), "Grain").toBe(true)
        project.editing.modify(await AudioContentModifier.toSignalsmith([adapter]))
        expect(Grooves.acceptsGroove(adapter.box), "Signalsmith until its engine work is done").toBe(false)
        project.terminate()
    })
    it("switching to No Sync removes the groove, undo brings it back", async () => {
        const {project, adapter, groove} = await setup()
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        project.editing.modify(() => adapter.box.groove.refer(groove))
        project.editing.modify(await AudioContentModifier.toNotStretched([adapter]))
        expect(adapter.box.groove.isEmpty()).toBe(true)
        project.editing.undo()
        expect(adapter.box.groove.targetVertex.unwrap().box).toBe(groove)
        project.terminate()
    })
    it("switching between synced modes keeps the groove", async () => {
        const {project, adapter, groove} = await setup()
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        project.editing.modify(() => adapter.box.groove.refer(groove))
        project.editing.modify(await AudioContentModifier.toSignalsmith([adapter]))
        expect(adapter.box.groove.targetVertex.unwrap().box).toBe(groove)
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        expect(adapter.box.groove.targetVertex.unwrap().box).toBe(groove)
        project.terminate()
    })
    it("a copy keeps the groove", async () => {
        const {project, adapter, groove} = await setup()
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        project.editing.modify(() => adapter.box.groove.refer(groove))
        const copy = project.editing.modify(() => adapter.copyTo({position: PPQN.Bar * 8})).unwrap()
        expect(copy.box.groove.targetVertex.unwrap().box).toBe(groove)
        expect(Grooves.users(groove).length).toBe(2)
        project.terminate()
    })
    it("deleting with fallback leaves the region without a groove and the Grooves list names it a region", async () => {
        const {project, adapter, groove} = await setup()
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        project.editing.modify(() => adapter.box.groove.refer(groove))
        const user = Grooves.userOf(adapter.box.groove)
        expect(user.type).toBe("timeline")
        if (user.type === "timeline") {
            expect(Grooves.isRegionBox(user.box)).toBe(true)
            expect(Grooves.unitOf(user.box).nonEmpty()).toBe(true)
        }
        project.editing.modify(() => Grooves.deleteAll(project, [groove], "fallback"))
        expect(adapter.box.groove.isEmpty()).toBe(true)
        project.terminate()
    })
})
