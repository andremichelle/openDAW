import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {StudioPreferences} from "../StudioPreferences"
import type {ProjectEnv} from "./ProjectEnv"

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

type Span = { position: number, duration: number }

// Two abutting regions: [0, 1920) and [1920, 3840). The duplicate of the first lands at 5760 (free).
const Abutting: ReadonlyArray<Span> = [{position: 0, duration: 1920}, {position: 1920, duration: 1920}]

const buildProject = async (layout: ReadonlyArray<Span>) => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    layout.forEach(({position, duration}) => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopDuration.setValue(duration)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        })
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter}
}

const setBehaviour = (value: "clip" | "push-existing" | "keep-existing") => {
    StudioPreferences.settings.editing["overlapping-regions-behaviour"] = value
}

afterEach(() => setBehaviour("clip"))

describe("ProjectApi.duplicateRegion with an explicit position", () => {
    it.each(["clip", "push-existing", "keep-existing"] as const)(
        "never modifies existing regions when the requested position is free (%s)", async (behaviour) => {
            setBehaviour(behaviour)
            const {project, trackAdapter} = await buildProject(Abutting)
            const [first, neighbor] = trackAdapter.regions.collection.asArray()
            const duplicate = project.editing.modify(() =>
                project.api.duplicateRegion(first, {position: 5760})).unwrap("modify")
            expect(duplicate.nonEmpty()).toBe(true)
            const copy = duplicate.unwrap()
            expect(copy.position).toBe(5760)
            expect(copy.duration).toBe(1920)
            expect(copy.trackBoxAdapter.unwrap("copy.track")).toBe(trackAdapter)
            expect(neighbor.position).toBe(1920)
            expect(neighbor.duration).toBe(1920)
            expect(trackAdapter.regions.collection.asArray().length).toBe(3)
            project.terminate()
        })

    it("evaluates overlap resolution at the final range, not at region.complete (clip)", async () => {
        setBehaviour("clip")
        const {project, trackAdapter} = await buildProject(Abutting)
        const [first, neighbor] = trackAdapter.regions.collection.asArray()
        // Target range [960, 2880) overlaps BOTH the source tail and the neighbor head: the neighbor must be
        // clipped at the FINAL range (its head trimmed to 2880), proving resolution ran where the copy landed.
        const duplicate = project.editing.modify(() =>
            project.api.duplicateRegion(first, {position: 960})).unwrap("modify")
        const copy = duplicate.unwrap()
        expect(copy.position).toBe(960)
        expect(neighbor.position).toBe(2880)
        project.terminate()
    })

    it("diverts the copy to the resolved track under keep-existing", async () => {
        setBehaviour("keep-existing")
        const {project, trackAdapter} = await buildProject(Abutting)
        const [first] = trackAdapter.regions.collection.asArray()
        // Position 1920 is occupied by the neighbor: keep-existing must leave it untouched and create the
        // copy on the resolved (freshly created) track below.
        const duplicate = project.editing.modify(() =>
            project.api.duplicateRegion(first, {position: 1920})).unwrap("modify")
        const copy = duplicate.unwrap()
        expect(copy.position).toBe(1920)
        expect(copy.trackBoxAdapter.unwrap("copy.track")).not.toBe(trackAdapter)
        expect(trackAdapter.regions.collection.asArray().length).toBe(2)
        project.terminate()
    })

    it("keeps the default place-after semantics without options", async () => {
        setBehaviour("clip")
        const {project, trackAdapter} = await buildProject([{position: 0, duration: 1920}])
        const [first] = trackAdapter.regions.collection.asArray()
        const duplicate = project.editing.modify(() =>
            project.api.duplicateRegion(first)).unwrap("modify")
        const copy = duplicate.unwrap()
        expect(copy.position).toBe(1920)
        expect(trackAdapter.regions.collection.asArray().length).toBe(2)
        project.terminate()
    })
})
