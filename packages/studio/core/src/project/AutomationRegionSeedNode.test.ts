import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBoxAdapter, AudioUnitBoxAdapter, InstrumentFactories, ProjectSkeleton, TrackBoxAdapter, TrackType,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {
    ApparatDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox, WerkstattParameterBox
} from "@opendaw/studio-boxes"
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

const buildValueTrack = async (target: "volume" | "mute" = "volume") => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    const volume = target === "volume" ? primaryAudioUnitBox.volume : primaryAudioUnitBox.mute
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
    const drawRegionBox = (position: number, duration: number): ValueRegionBox =>
        project.editing.modify(() => project.api.createTrackRegion(trackBox, position, duration))
            .unwrap("modify").unwrap("region") as ValueRegionBox
    const drawRegion = (position: number, duration: number): number =>
        project.boxAdapters.adapterFor(drawRegionBox(position, duration), ValueRegionBoxAdapter).incomingValue(-1)
    const seedInterpolation = (position: number, duration: number): Interpolation => {
        const adapter = project.boxAdapters.adapterFor(drawRegionBox(position, duration), ValueRegionBoxAdapter)
        const [event] = adapter.events.unwrap("events").asArray()
        return event.interpolation
    }
    return {project, parameter, makeRamp, drawRegion, seedInterpolation}
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

    it("a float parameter's seed interpolates linearly", async () => {
        const {seedInterpolation} = await buildValueTrack("volume")
        expect(seedInterpolation(0, 3840).type).toBe("linear")
    })

    it("a non-floating parameter's seed steps instead of ramping", async () => {
        const {seedInterpolation} = await buildValueTrack("mute")
        expect(seedInterpolation(0, 3840).type).toBe("none")
    })
    it("a script dial declared int steps although its field stores a float (#555)", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(env(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const trackBox = project.editing.modify(() => {
            const {audioUnitBox, instrumentBox} = project.api.createAnyInstrument(InstrumentFactories.Apparat)
            const apparat = instrumentBox as ApparatDeviceBox
            apparat.code.setValue("// @param octave 0 -2 2 int\nclass Processor {}")
            const paramBox = WerkstattParameterBox.create(project.boxGraph, UUID.generate(), box => {
                box.owner.refer(apparat.parameters)
                box.label.setValue("octave")
            })
            project.boxAdapters.adapterFor(apparat, ApparatDeviceBoxAdapter)
            return TrackBox.create(project.boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Value)
                box.tracks.refer(audioUnitBox.tracks)
                box.target.refer(paramBox.value)
                box.index.setValue(1)
            })
        }).unwrap("modify")
        project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
        const regionBox = project.editing.modify(() => project.api.createTrackRegion(trackBox, 0, 3840))
            .unwrap("modify").unwrap("region") as ValueRegionBox
        const [event] = project.boxAdapters.adapterFor(regionBox, ValueRegionBoxAdapter).events.unwrap("events").asArray()
        expect(event.interpolation.type).toBe("none")
        project.terminate()
    })
})
