import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {TrackBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, InstrumentFactories, ProjectSkeleton, TrackBoxAdapter} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./ProjectEnv"

// A host that removes a track once its last region leaves has to write from the region collection's onRemoved.
// Writing there directly loses the track's own removal notification, so AudioUnitBoxAdapter.tracks keeps a dead
// adapter and never lists the track that undo restores. BoxGraph.afterTransaction runs the delete in a follow-up
// transaction instead, inside the same undo step. The reaction sits on every track, including the ones undo
// restores, and undo and redo replay the recorded step without running it again.

const fakeEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const setup = async () => {
    if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(fakeEnv(), skeleton)
    const {editing, boxGraph, boxAdapters} = project
    const {audioUnitBox, firstTrack, secondTrack, region} = editing.modify(() => {
        const {audioUnitBox, trackBox} = project.api.createInstrument(InstrumentFactories.Vaporisateur)
        const secondTrack = project.api.createNoteTrack(audioUnitBox)
        const region = project.api.createNoteRegion({trackBox: secondTrack, position: 0, duration: 3840})
        return {audioUnitBox, firstTrack: trackBox, secondTrack, region}
    }).unwrap()
    const unit = boxAdapters.adapterFor(audioUnitBox, AudioUnitBoxAdapter)
    unit.tracks.catchupAndSubscribe({
        onAdd: ({box: trackBox, regions}) => regions.catchupAndSubscribe({
            onAdded: () => {},
            onRemoved: () => boxGraph.afterTransaction(() => {
                const emptied = trackBox.isAttached() && trackBox.regions.pointerHub.isEmpty()
                if (emptied && audioUnitBox.tracks.pointerHub.size() > 1) {trackBox.delete()}
            })
        }),
        onRemove: () => {},
        onReorder: () => {}
    })
    const isAlive = (box: Box) => boxGraph.findBox(box.address.uuid).nonEmpty()
    const listedTrackBoxes = () => unit.tracks.values().map(adapter => adapter.box)
    const restoredSecondTrack = () => boxGraph.findBox<TrackBox>(secondTrack.address.uuid).unwrap("second track")
    const regionTrack = () => region.regions.targetVertex.unwrap("region track").box
    return {
        editing, boxGraph, boxAdapters, unit, firstTrack, secondTrack, region,
        isAlive, listedTrackBoxes, restoredSecondTrack, regionTrack
    }
}

describe("deleting a track from its region collection via BoxGraph.afterTransaction", () => {
    it("deleting the last region on a second note track removes that track in the same undo step, and AudioUnitBoxAdapter.tracks stays in sync through undo and redo", async () => {
        const {
            editing, boxAdapters, unit, firstTrack, secondTrack, region, isAlive, listedTrackBoxes, restoredSecondTrack
        } = await setup()
        expect(listedTrackBoxes()).toEqual([firstTrack, secondTrack])
        editing.modify(() => region.delete())
        expect(isAlive(region)).toBe(false)
        expect(isAlive(secondTrack)).toBe(false)
        expect(listedTrackBoxes()).toEqual([firstTrack])
        expect(unit.tracks.collection.getAdapterById(secondTrack.address.uuid).isEmpty()).toBe(true)
        expect(editing.undo()).toBe(true)
        expect(isAlive(region)).toBe(true)
        expect(isAlive(secondTrack)).toBe(true)
        const restored = restoredSecondTrack()
        expect(listedTrackBoxes()).toEqual([firstTrack, restored])
        expect(boxAdapters.adapterFor(restored, TrackBoxAdapter).regions.collection.asArray().length).toBe(1)
        expect(editing.redo()).toBe(true)
        expect(isAlive(region)).toBe(false)
        expect(isAlive(secondTrack)).toBe(false)
        expect(listedTrackBoxes()).toEqual([firstTrack])
        expect(unit.tracks.values().every(adapter => adapter.box.isAttached())).toBe(true)
    })

    it("moving the region to the first track removes the second track in the same step, and undo and redo bring both tracks back and take the second away again without running the reaction", async () => {
        const {
            editing, boxGraph, firstTrack, region, isAlive, listedTrackBoxes, restoredSecondTrack, regionTrack
        } = await setup()
        editing.modify(() => region.regions.refer(firstTrack.regions))
        expect(listedTrackBoxes()).toEqual([firstTrack])
        expect(regionTrack()).toBe(firstTrack)
        // the undo empties the first track, and a reaction run there would delete it outside history
        expect(editing.undo()).toBe(true)
        const restored = restoredSecondTrack()
        expect(isAlive(firstTrack)).toBe(true)
        expect(listedTrackBoxes()).toEqual([firstTrack, restored])
        expect(regionTrack()).toBe(restored)
        expect(editing.redo()).toBe(true)
        expect(isAlive(restored)).toBe(false)
        expect(listedTrackBoxes()).toEqual([firstTrack])
        expect(regionTrack()).toBe(firstTrack)
        expect(boxGraph.unresolvablePointers()).toEqual([])
    })
})
