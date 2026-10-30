import {describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, NoteRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox} from "@opendaw/studio-boxes"
import type {TracksManager} from "../TracksManager"
import type {Snapping} from "@/ui/timeline/Snapping"
import {RegionMoveModifier} from "./RegionMoveModifier"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})
const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})
describe("region moves with folded selections", () => {
    it.each([false, true])("moves only visible selected regions (copy=%s)", async copy => {
        const {Project} = await import("@opendaw/studio-core")
        const project = Project.fromSkeleton({
            audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
            soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
        } as unknown as Parameters<typeof Project.fromSkeleton>[0],
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const products = project.editing.modify(() => [0, 1, 2].map(() => project.api.createAnyInstrument(InstrumentFactories.Neon))).unwrap()
        const regions = project.editing.modify(() => products.slice(0, 2).map(product => {
            const events = NoteEventCollectionBox.create(project.boxGraph, UUID.generate())
            return NoteRegionBox.create(project.boxGraph, UUID.generate(), box => {
                box.regions.refer(product.trackBox.regions)
                box.events.refer(events.owners)
                box.duration.setValue(960)
                box.loopDuration.setValue(960)
            })
        })).unwrap().map(box => project.boxAdapters.adapterFor(box, NoteRegionBoxAdapter))
        project.regionSelection.select(...regions)
        const group = project.editing.modify(() => project.grouping.create([products[1].audioUnitBox]).unwrap()).unwrap()
        project.editing.modify(() => group.groupCollapsed.setValue(true))
        const tracks = products.map(product => project.boxAdapters.adapterFor(product.trackBox, TrackBoxAdapter))
        tracks[0].listIndex = 0
        tracks[1].listIndex = -1
        tracks[2].listIndex = 1
        const visible = [tracks[0], tracks[2]]
        const manager = {
            service: {project}, numTracks: () => visible.length, globalToIndex: () => 1,
            getByIndex: (index: number) => Option.wrap(visible[index]).map(trackBoxAdapter => ({trackBoxAdapter}))
        } as unknown as TracksManager
        const modifier = RegionMoveModifier.create(manager, project.regionSelection, {
            element: {getBoundingClientRect: () => ({left: 0})} as Element,
            snapping: {computeDelta: () => 240} as unknown as Snapping,
            pointerPulse: 0, pointerIndex: 0, reference: regions[0]
        }).unwrap()
        modifier.update({clientX: 10, clientY: 10, altKey: false, shiftKey: false, ctrlKey: copy})
        expect(modifier.deltaIndex).toBe(1)
        modifier.approve()
        expect(regions[1].trackBoxAdapter.unwrap()).toBe(tracks[1])
        expect(regions[1].position).toBe(0)
        expect(tracks[1].regions.collection.asArray()).toEqual([regions[1]])
        expect(tracks[2].regions.collection.asArray()).toHaveLength(1)
        expect(tracks[2].regions.collection.asArray()[0].position).toBe(240)
        expect(project.editing.undo()).toBe(true)
        expect(tracks[2].regions.collection.asArray()).toHaveLength(0)
        expect(regions[1].position).toBe(0)
        project.terminate()
    })
})
