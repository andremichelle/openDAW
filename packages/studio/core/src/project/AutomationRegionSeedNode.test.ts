import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType, ValueRegionBoxAdapter} from "@opendaw/studio-adapters"
import {TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {StudioPreferences} from "../StudioPreferences"
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

const buildValueTrack = async () => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    const volume = primaryAudioUnitBox.volume
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(volume)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(env(), skeleton)
    project.boxAdapters.adapterFor(primaryAudioUnitBox, AudioUnitBoxAdapter) // registers the volume parameter adapter
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    const parameter = project.parameterFieldAdapters.opt(volume.address).unwrap("volume parameter")
    const makeRamp = (position: number, duration: number, v0: number, v1: number) => project.editing.modify(() => {
        const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position); box.duration.setValue(duration); box.loopDuration.setValue(duration)
            box.events.refer(collection.owners); box.regions.refer(trackBox.regions)
        })
        ValueEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(0); box.value.setValue(v0); box.events.refer(collection.events)
        })
        ValueEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(duration); box.index.setValue(1); box.value.setValue(v1)
            box.events.refer(collection.events)
        })
    })
    const drawRegion = (position: number, duration: number): number => {
        const box = project.editing.modify(() => project.api.createTrackRegion(trackBox, position, duration))
            .unwrap("modify").unwrap("region")
        return project.boxAdapters.adapterFor(box, ValueRegionBoxAdapter).incomingValue(-1)
    }
    return {project, parameter, makeRamp, drawRegion}
}

afterEach(() => StudioPreferences.settings.editing["overlapping-regions-behaviour"] = "clip")

describe("new automation region seeds an inherited node (#271)", () => {
    it("empty track: inherits the parameter's current dial value", async () => {
        const {parameter, drawRegion} = await buildValueTrack()
        expect(drawRegion(0, 3840)).toBeCloseTo(parameter.getControlledUnitValue())
    })

    it("placed AFTER a ramp: inherits the preceding region's held (outgoing) value", async () => {
        const {makeRamp, drawRegion} = await buildValueTrack()
        makeRamp(0, 3840, 0.2, 0.8)
        expect(drawRegion(3840, 3840)).toBeCloseTo(0.8)
    })

    it("placed BEFORE a ramp: inherits the following region's incoming value", async () => {
        const {makeRamp, drawRegion} = await buildValueTrack()
        makeRamp(7680, 3840, 0.2, 0.8)
        expect(drawRegion(0, 3840)).toBeCloseTo(0.2)
    })
})
