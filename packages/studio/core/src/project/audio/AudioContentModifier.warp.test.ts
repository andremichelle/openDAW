import {describe, expect, it} from "vitest"
import {asDefined, isDefined, Option, quantizeRound, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, ProjectSkeleton, SampleMetaData, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {AudioContentModifier} from "./AudioContentModifier"
import type {ProjectEnv} from "../ProjectEnv"

// Converting a not-stretched region to a stretched play-mode used to seed the last warp marker from the
// REGION's length instead of the AUDIO's. The two are free to disagree: enlarge a region so it spans four
// bars and its audio still ends earlier (the waveform visibly stops), so the marker landed in the silence
// past the audio end and the content kept playing at 1:1 instead of warping onto the grid.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const SAMPLE_BPM = 128.0
const PROJECT_BPM = 120.0
// Four bars at the sample's own tempo. At the project's 120 bpm those same seconds are shorter than four
// bars, which is exactly the case where region length and audio length part ways.
const AUDIO_SECONDS = 4.0 * 4.0 * 60.0 / SAMPLE_BPM
const FOUR_BARS = PPQN.Bar * 4

const createEnv = (meta: Option<SampleMetaData>): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, soundfontManager: undefined,
    sampleService: undefined, soundfontService: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get meta() {return meta},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    }
}) as unknown as ProjectEnv

const setup = async (contentSeconds: number, meta: Option<SampleMetaData>) => {
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
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(contentSeconds)
        box.loopDuration.setValue(contentSeconds)
        box.timeBase.setValue(TimeBase.Seconds)
        box.regions.refer(trackBox.regions)
        box.file.refer(audioFileBox)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(meta), skeleton)
    return {project, adapter: project.boxAdapters.adapterFor(regionBox, AudioRegionBoxAdapter)}
}

const sampleMeta = (bpm: number): Option<SampleMetaData> => Option.wrap({
    name: "loop.wav", bpm, duration: AUDIO_SECONDS, sample_rate: 48000, origin: "import" as const
})

const lastMarker = (adapter: AudioRegionBoxAdapter) => asDefined(
    adapter.optWarpMarkers.unwrap("no warp markers").last(), "no last marker")

describe("converting to a stretched play-mode warps the AUDIO, not the region's own length", () => {
    it("maps the audio onto the musical span the user gave the region", async () => {
        // Four bars at the PROJECT tempo, which is longer than the audio: the enlarged case.
        const enlarged = 4.0 * 4.0 * 60.0 / PROJECT_BPM
        const {project, adapter} = await setup(enlarged, sampleMeta(SAMPLE_BPM))
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        const marker = lastMarker(adapter)
        expect(marker.seconds, "the last marker must point at the audio end, not into the silence after it")
            .toBeCloseTo(AUDIO_SECONDS, 6)
        expect(marker.position, "the span the user set must be preserved").toBe(FOUR_BARS)
        expect(adapter.duration).toBe(FOUR_BARS)
        project.terminate()
    })

    it("warps a region still covering its audio to the sample's own tempo", async () => {
        const {project, adapter} = await setup(AUDIO_SECONDS, sampleMeta(SAMPLE_BPM))
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        const marker = lastMarker(adapter)
        expect(marker.seconds).toBeCloseTo(AUDIO_SECONDS, 6)
        expect(marker.position, "the sample's own tempo makes it four bars").toBe(FOUR_BARS)
        expect(adapter.duration, "and the region is resized to match").toBe(FOUR_BARS)
        project.terminate()
    })

    it("returns to the grid after a stretched -> no-stretch -> stretched round trip", async () => {
        const {project, adapter} = await setup(AUDIO_SECONDS, sampleMeta(SAMPLE_BPM))
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        expect(adapter.duration, "four bars to begin with").toBe(FOUR_BARS)
        project.editing.modify(await AudioContentModifier.toNotStretched([adapter]))
        expect(adapter.box.duration.getValue(), "shrinks back to its length in seconds")
            .toBeCloseTo(AUDIO_SECONDS, 6)
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        expect(adapter.duration, "and back onto the grid at the sample's own tempo").toBe(FOUR_BARS)
        project.terminate()
    })

    // The mapping must not depend on the region and the audio lining up exactly. Anything that shortens the
    // audible part (here a waveform offset, i.e. content dragged inside the region) used to drop the whole
    // conversion back to the project-tempo reading, which is the very thing this is supposed to fix.
    it("uses the sample's tempo even when the region no longer matches its audio", async () => {
        const {project, adapter} = await setup(AUDIO_SECONDS, sampleMeta(SAMPLE_BPM))
        project.editing.modify(() => adapter.box.waveformOffset.setValue(1.0))
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        const marker = lastMarker(adapter)
        const remaining = AUDIO_SECONDS - 1.0
        expect(marker.seconds).toBeCloseTo(remaining, 6)
        expect(marker.position, "the remaining audio, measured at the sample's own tempo")
            .toBe(quantizeRound(PPQN.secondsToPulses(remaining, SAMPLE_BPM), PPQN.SemiQuaver))
        project.terminate()
    })

    it("falls back to the region's span when the sample's tempo is unknown", async () => {
        const {project, adapter} = await setup(AUDIO_SECONDS, Option.None)
        project.editing.modify(await AudioContentModifier.toPitchStretch([adapter]))
        const marker = lastMarker(adapter)
        expect(marker.seconds).toBeCloseTo(AUDIO_SECONDS, 6)
        // AUDIO_SECONDS read at the project tempo, i.e. what the region already occupied.
        expect(marker.position).toBe(PPQN.secondsToPulses(AUDIO_SECONDS, PROJECT_BPM))
        project.terminate()
    })
})
