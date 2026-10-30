import {describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {subscribeGroupOverview} from "./GroupOverviewUpdates"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

describe("folded group redraws", () => {
    it("watches descendant regions only, follows routing and releases subscriptions when unfolded", async () => {
        const {Project} = await import("@opendaw/studio-core")
        const project = Project.fromSkeleton({
            audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
            soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
        } as unknown as Parameters<typeof Project.fromSkeleton>[0],
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const products = project.editing.modify(() => [0, 1].map(() => project.api.createAnyInstrument(InstrumentFactories.Neon))).unwrap()
        const [inside, outside] = products
        const group = project.editing.modify(() => project.grouping.create([inside.audioUnitBox]).unwrap()).unwrap()
        const regions = project.editing.modify(() => products.map(product => {
            const events = NoteEventCollectionBox.create(project.boxGraph, UUID.generate())
            return NoteRegionBox.create(project.boxGraph, UUID.generate(), box => {
                box.regions.refer(product.trackBox.regions)
                box.events.refer(events.owners)
                box.duration.setValue(960)
                box.loopDuration.setValue(960)
            })
        })).unwrap()
        project.editing.modify(() => group.groupCollapsed.setValue(true))
        const redraw = vi.fn()
        const subscription = subscribeGroupOverview(project, group, redraw)
        redraw.mockClear()
        project.editing.modify(() => regions[1].position.setValue(100))
        expect(redraw).not.toHaveBeenCalled()
        project.editing.modify(() => regions[0].position.setValue(100))
        expect(redraw).toHaveBeenCalled()
        redraw.mockClear()
        project.editing.modify(() => inside.audioUnitBox.volume.setValue(-12))
        expect(redraw).not.toHaveBeenCalled()
        project.editing.modify(() => project.grouping.move([outside.audioUnitBox], group))
        redraw.mockClear()
        project.editing.modify(() => regions[1].position.setValue(200))
        expect(redraw).toHaveBeenCalled()
        project.editing.modify(() => group.groupCollapsed.setValue(false))
        redraw.mockClear()
        project.editing.modify(() => regions[0].position.setValue(200))
        expect(redraw).not.toHaveBeenCalled()
        subscription.terminate()
        project.terminate()
    })
})
