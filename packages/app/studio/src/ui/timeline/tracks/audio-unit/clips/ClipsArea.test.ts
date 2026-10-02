import {afterEach, describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {Dragging} from "@opendaw/lib-dom"
import {ClipsView} from "@/ui/timeline/ClipsView"
import {ClipWidth} from "./constants"
import {ClipsArea} from "./ClipsArea"

const harness = vi.hoisted(() => ({attach: vi.fn(), subscribe: vi.fn()}))

vi.mock("@opendaw/lib-jsx", () => ({
    createElement: (tag: string | ((props: object) => object), props: object) => typeof tag === "function"
        ? tag(props) : {style: {}, clientWidth: 3 * ClipWidth, appendChild() {}, getBoundingClientRect: () => ({left: 100})}
}))
vi.mock("@opendaw/lib-dom", async importOriginal => {
    const original = await importOriginal<typeof import("@opendaw/lib-dom")>()
    return {...original, Html: {adoptStyleSheet: () => "test"},
        Dragging: {attach: harness.attach}, Events: {subscribe: harness.subscribe, subscribeDblDwn: () => Terminable.Empty},
        Keyboard: {isControlKey: ({ctrlKey}: PointerEvent) => ctrlKey}}
})
vi.mock("@/ui/tour/TourAnchors", () => ({TourAnchors: {registerRect() {}}}))
vi.mock("@/ui/timeline/SelectionRectangle.tsx", () => ({SelectionRectangle: () => ({})}))
vi.mock("@/ui/AutoScroll.ts", () => ({installAutoScroll: () => Terminable.Empty}))
vi.mock("./ClipContextMenu.ts", () => ({installClipContextMenu: () => Terminable.Empty}))
vi.mock("@/ui/DragAndDrop.ts", () => ({DragAndDrop: {installTarget: () => Terminable.Empty}}))
vi.mock("@/ui/components/dialogs", () => ({Dialogs: {}}))
vi.mock("./ClipCapturing.ts", () => ({ClipCapturing: {create: () => ({captureEvent: () => ({type: "clip"})})}}))
vi.mock("./ClipDragAndDrop.ts", () => ({ClipDragAndDrop: class {}}))

afterEach(() => {vi.clearAllMocks(); vi.unstubAllGlobals()})

const setup = () => {
    const lifecycle = new Terminator()
    const clips = new ClipsView(new DefaultObservableValue(true))
    const index = new DefaultObservableValue(0)
    const refer = vi.fn()
    const dispatchChange = vi.fn()
    const track = {listIndex: 0, accepts: () => true, box: {clips: {}},
        clips: {dispatchChange, collection: {getAdapterByIndex: () => Option.None}}}
    const adapter = {indexField: index, trackBoxAdapter: Option.wrap(track), isMirrowed: false,
        box: {index, clips: {refer}}}
    const selection = {selected: () => [adapter], catchupAndSubscribe: () => Terminable.Empty, terminate() {}}
    const context = {trackBoxAdapter: track}
    const manager = {tracks: () => [context], numTracks: () => 1, getByIndex: () => Option.wrap(context),
        globalToIndex: () => 0, startClipModifier: (option: Option<Dragging.Process>) => option}
    const service = {timeline: {clips}, project: {selection: {createFilteredSelection: () => selection},
        editing: {modify: (procedure: () => void) => procedure()},
        userEditingManager: {timeline: {isEditing: () => false}}}}
    harness.attach.mockReturnValue(Terminable.Empty)
    harness.subscribe.mockReturnValue(Terminable.Empty)
    ClipsArea({lifecycle, service, manager, scrollModel: {}, scrollContainer: {scrollTop: 0}} as unknown as
        Parameters<typeof ClipsArea>[0])
    const factory = harness.attach.mock.calls[0][1] as Parameters<typeof Dragging.attach>[1]
    const begin = Object.create({clientX: 101, clientY: 0, altKey: false, shiftKey: false,
        ctrlKey: false, metaKey: false}) as PointerEvent
    const process = factory(begin).unwrap()
    const pointer = {clientX: 101 + ClipWidth, clientY: 0, altKey: false, shiftKey: false, ctrlKey: false}
    return {lifecycle, clips, index, dispatchChange, process, pointer}
}

describe("clip move scrolling", () => {
    it("updates the preview and commits beneath a stationary pointer after scrolling", () => {
        const {lifecycle, clips, index, dispatchChange, process, pointer} = setup()
        process.update(pointer)
        const changesBeforeScroll = dispatchChange.mock.calls.length
        clips.scrollBy(4)
        expect(clips.scroll.getValue()).toBe(4)
        expect(dispatchChange.mock.calls.length).toBeGreaterThan(changesBeforeScroll)
        process.approve?.()
        process.finally?.()
        expect(index.getValue()).toBe(5)
        const changesAfterDrop = dispatchChange.mock.calls.length
        clips.scrollBy(1)
        expect(dispatchChange).toHaveBeenCalledTimes(changesAfterDrop)
        lifecycle.terminate()
    })
    it("uses the initial pointer when scrolling before the first pointer move", () => {
        const {lifecycle, clips, index, process} = setup()
        clips.scrollBy(4)
        process.approve?.()
        process.finally?.()
        expect(index.getValue()).toBe(4)
        lifecycle.terminate()
    })
    it("stops refreshing a cancelled move", () => {
        const {lifecycle, clips, index, dispatchChange, process, pointer} = setup()
        process.update(pointer)
        process.cancel?.()
        process.finally?.()
        const changesAfterCancel = dispatchChange.mock.calls.length
        clips.scrollBy(4)
        expect(dispatchChange).toHaveBeenCalledTimes(changesAfterCancel)
        expect(index.getValue()).toBe(0)
        lifecycle.terminate()
    })
    it("stops refreshing when the clips area is disposed", () => {
        const {lifecycle, clips, dispatchChange, process, pointer} = setup()
        process.update(pointer)
        lifecycle.terminate()
        const changesAfterDisposal = dispatchChange.mock.calls.length
        clips.scrollBy(4)
        expect(dispatchChange).toHaveBeenCalledTimes(changesAfterDisposal)
    })
})
