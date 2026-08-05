import {afterEach, describe, expect, it, vi} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {StudioPreferences} from "../StudioPreferences"
import {RegionClipResolver} from "../ui/timeline/RegionClipResolver"
import type {ProjectEnv} from "./ProjectEnv"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}
const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})
const env = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const buildNotesTrack = async () => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(env(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackBox, trackAdapter}
}

afterEach(() => {
    StudioPreferences.settings.editing["overlapping-regions-behaviour"] = "clip"
    RegionClipResolver.fatal = true
})

describe("createTrackRegion resolves overlaps (live errors 1086/1087)", () => {
    it("a second region drawn at the same position clips the first instead of stacking", async () => {
        const {project, trackBox, trackAdapter} = await buildNotesTrack()
        project.editing.modify(() => project.api.createTrackRegion(trackBox, 0, 6720))
        project.editing.modify(() => project.api.createTrackRegion(trackBox, 0, 6720)) // clip mode: covers + removes the first
        const regions = trackAdapter.regions.collection.asArray()
        expect(regions.length).toBe(1)
        expect(regions[0].position).toBe(0)
        expect(regions[0].duration).toBe(6720)
    })

    it("validateTracks no longer panics after overlapping creates — the crash is gone", async () => {
        const {project, trackBox, trackAdapter} = await buildNotesTrack()
        project.editing.modify(() => project.api.createTrackRegion(trackBox, 0, 6720))
        project.editing.modify(() => project.api.createTrackRegion(trackBox, 0, 6720))
        expect(() => RegionClipResolver.validateTracks([trackAdapter])).not.toThrow()
    })
})

describe("validateTrack non-fatal net (pre-existing overlaps must not crash the session)", () => {
    it("fatal=true throws, fatal=false logs and continues on the SAME overlapping data", async () => {
        const {project, trackBox, trackAdapter} = await buildNotesTrack()
        // Force a genuine overlap: two creates in ONE transaction stack, since the adapter collection is not
        // updated mid-transaction, so the second create's resolver sees an empty track.
        project.editing.modify(() => {
            project.api.createTrackRegion(trackBox, 0, 6720)
            project.api.createTrackRegion(trackBox, 0, 6720)
        })
        expect(trackAdapter.regions.collection.asArray().length).toBe(2)
        RegionClipResolver.fatal = true
        expect(() => RegionClipResolver.validateTracks([trackAdapter]))
            .toThrow("regions overlap: prev.complete(6720) > next.position(0)")
        RegionClipResolver.fatal = false
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(() => RegionClipResolver.validateTracks([trackAdapter])).not.toThrow()
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })
})
