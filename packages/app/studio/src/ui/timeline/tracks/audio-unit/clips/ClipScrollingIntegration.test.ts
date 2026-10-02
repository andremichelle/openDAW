import {afterEach, describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, Option} from "@opendaw/lib-std"
import {TrackType} from "@opendaw/studio-adapters"
import {ClipsView} from "@/ui/timeline/ClipsView"
import {ClipWidth} from "./constants"
import {createClipSelectableLocator} from "./ClipSelectableLocator"
import {ClipDragAndDrop} from "./ClipDragAndDrop"
import {ResolvedSampleDrop, TimelineDragAndDrop} from "../TimelineDragAndDrop"

const factory = vi.hoisted(() => ({createNotStretchedClip: vi.fn(), createTimeStretchedClip: vi.fn()}))
vi.mock("@opendaw/studio-core", () => ({AudioContentFactory: factory, AudioFileBoxFactory: {}, Workers: {}}))

afterEach(() => {vi.restoreAllMocks(); vi.clearAllMocks()})

describe("clip scrolling integration", () => {
    it("preserves a model-column selection anchor across scrolling and converts point capture to local pixels", () => {
        const clips = new ClipsView(new DefaultObservableValue(true))
        const adapters = [1, 3, 4, 5].map(index => ({indexField: new DefaultObservableValue(index)}))
        const track = {position: 0, trackBoxAdapter: {clips: {collection: {adapters: () => adapters}}}}
        const captureLocalPoint = vi.fn(() => ({type: "clip", clip: adapters[1]}))
        const locator = createClipSelectableLocator(
            {captureLocalPoint} as unknown as Parameters<typeof createClipSelectableLocator>[0],
            {tracks: () => [track], localToIndex: () => 0, scrollableContainer: {scrollTop: 10}} as unknown as
                Parameters<typeof createClipSelectableLocator>[1], clips.scroll)
        const anchor = ClipWidth
        clips.scrollTo(2)
        const endpoint = (clips.scroll.getValue() + 2) * ClipWidth
        expect(Array.from(locator.selectablesBetween({u: anchor, v: 0}, {u: endpoint, v: 40})))
            .toEqual(adapters.slice(0, 3))
        expect(Array.from(locator.selectableAt({u: 3 * ClipWidth, v: 30}))).toEqual([adapters[1]])
        expect(captureLocalPoint).toHaveBeenCalledWith(ClipWidth, 20)
    })
    it("creates and replaces at the drop-time column even when the launcher scrolls during sample loading", async () => {
        const clips = new ClipsView(new DefaultObservableValue(true))
        clips.scrollTo(13)
        const deleted = vi.fn()
        const getAdapterByIndex = vi.fn(() => Option.wrap({box: {delete: deleted}}))
        const trackBoxAdapter = {type: TrackType.Audio, box: {}, clips: {collection: {getAdapterByIndex}}}
        const service = {timeline: {clips}, project: {boxGraph: {},
            editing: {modify: (procedure: () => void) => procedure()}}}
        const capturing = {element: {getBoundingClientRect: () => ({left: 100})},
            captureEvent: () => ({type: "track", track: {trackBoxAdapter}})}
        const dragAndDrop = new ClipDragAndDrop(service as unknown as ConstructorParameters<typeof ClipDragAndDrop>[0],
            capturing as unknown as ConstructorParameters<typeof ClipDragAndDrop>[1])
        const pending = Promise.withResolvers<ReadonlyArray<ResolvedSampleDrop>>()
        vi.spyOn(TimelineDragAndDrop, "resolveSamples").mockReturnValue(pending.promise)
        const event = {clientX: 100 + 2 * ClipWidth} as DragEvent
        const sample = {bpm: 0} as ResolvedSampleDrop["sample"]
        const drop = dragAndDrop.drop(event, {type: "sample", sample})
        expect(factory.createNotStretchedClip).not.toHaveBeenCalled()
        clips.scrollTo(0)
        pending.resolve([{sample, type: "sample", audioFileBoxFactory: () => ({}) as ReturnType<ResolvedSampleDrop["audioFileBoxFactory"]>}])
        await drop
        expect(getAdapterByIndex).toHaveBeenCalledExactlyOnceWith(15)
        expect(deleted).toHaveBeenCalledOnce()
        expect(factory.createNotStretchedClip).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({index: 15}))
        expect(clips.columns.getValue()).toBe(17)
    })
})
