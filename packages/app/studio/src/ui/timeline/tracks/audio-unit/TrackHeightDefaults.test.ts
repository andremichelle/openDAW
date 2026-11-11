import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "@opendaw/studio-core"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

afterEach(async () => {
    const {TrackHeightDefaults} = await import("@opendaw/studio-core")
    TrackHeightDefaults.remember(48)
})

describe("new track height defaults", () => {
    it("migrates older preferences with the existing 48 px default", async () => {
        const {StudioSettingsSchema} = await import("@opendaw/studio-core")
        const settings = StudioSettingsSchema.parse({timeline: {
            markers: false, tempo: true, signature: false, clips: true, "follow-cursor": false
        }})
        expect(settings.timeline["default-track-height"]).toBe(48)
        expect(settings.timeline.markers).toBe(false)
        expect(settings.timeline.tempo).toBe(true)
    })
    it("uses the latest preference for new instruments and lanes without changing existing tracks", async () => {
        const {Project, TrackHeightDefaults} = await import("@opendaw/studio-core")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        TrackHeightDefaults.remember(48)
        const first = project.editing.modify(() => project.api.createInstrument(InstrumentFactories.Nano)).unwrap()
        expect(first.trackBox.height.getValue()).toBe(48)
        TrackHeightDefaults.remember(93)
        const second = project.editing.modify(() => project.api.createInstrument(InstrumentFactories.Nano)).unwrap()
        expect(second.trackBox.height.getValue()).toBe(93)
        const lane = project.editing.modify(() => project.api.createAudioTrack(second.audioUnitBox, 1)).unwrap()
        expect(lane.height.getValue()).toBe(93)
        expect(first.trackBox.height.getValue()).toBe(48)
        project.terminate()
    })
    it("does not overwrite saved heights when the default changes", async () => {
        const {TrackHeightDefaults} = await import("@opendaw/studio-core")
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        boxGraph.beginTransaction()
        const old = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.height.setValue(120)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
            box.type.setValue(TrackType.Notes)
        })
        const themeDefault = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(1)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
            box.type.setValue(TrackType.Notes)
        })
        TrackHeightDefaults.remember(80)
        expect(old.height.getValue()).toBe(120)
        expect(themeDefault.height.getValue()).toBe(0)
        boxGraph.endTransaction()
    })
    it("normalizes preference values to the supported track range", async () => {
        const {TrackHeightDefaults} = await import("@opendaw/studio-core")
        expect(TrackHeightDefaults.normalize(0)).toBe(48)
        expect(TrackHeightDefaults.normalize(97.6)).toBe(98)
        expect(TrackHeightDefaults.normalize(1000)).toBe(240)
        expect(TrackHeightDefaults.normalize(Number.NaN)).toBe(48)
    })
})
