import {afterEach, describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, isDefined, Option, Optional, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame} from "@opendaw/lib-dom"
import {ClipsView} from "@/ui/timeline/ClipsView"

const harness = vi.hoisted(() => {
    class Element {
        children: Array<Element> = []
        parent: Optional<Element>
        textContent = ""
        classList = {toggle: () => {}}
        get firstElementChild() {return this.children[0]}
        appendChild(child: Element) {child.parent = this; this.children.push(child)}
        remove() {
            if (isDefined(this.parent)) {this.parent.children.splice(this.parent.children.indexOf(this), 1)}
        }
    }
    return {Element}
})

vi.mock("@opendaw/lib-jsx", () => ({
    createElement: (tag: string | ((props: object) => object), props: object, ...children: Array<object>) => {
        if (typeof tag === "function") {return tag(props)}
        const element = new harness.Element()
        children.flat().forEach(child => {if (child instanceof harness.Element) {element.appendChild(child)}})
        return element
    }
}))
vi.mock("@opendaw/lib-dom", async importOriginal => {
    const original = await importOriginal<typeof import("@opendaw/lib-dom")>()
    return {...original, Html: {adoptStyleSheet: () => "test"},
        Events: {subscribe: () => ({terminate() {}})}, Dragging: {attach: () => ({terminate() {}})}}
})
vi.mock("@/ui/timeline/tracks/audio-unit/TrackStyles.ts", () => ({ClipLaneClassName: "test"}))
vi.mock("@/ui/timeline/tracks/audio-unit/clips/ClipPlaceholder.tsx", () => ({
    ClipPlaceholder: ({lifecycle, adapter}: Parameters<typeof import("./ClipPlaceholder").ClipPlaceholder>[0]) => {
        const element = new harness.Element()
        lifecycle.own(adapter.catchupAndSubscribe(owner => {
            element.textContent = isDefined(owner.getValue()) ? "clip" : "empty"
        }))
        return element
    }
}))
vi.mock("@/ui/timeline/tracks/audio-unit/clips/ClipModifyStrategy.ts", () => ({
    ClipModifyStrategies: {Identity: () => ({
        unselectedModifyStrategy: () => ({translateTrackIndex: () => 0, readClipIndex: () => 0, readMirror: () => false}),
        selectedModifyStrategy: () => ({translateTrackIndex: () => 0, readClipIndex: () => 0, readMirror: () => false}),
        showOrigin: () => true
    })}
}))
vi.mock("@/ui/components/Icon.tsx", () => ({Icon: () => new harness.Element()}))
vi.mock("@/ui/surface/TextTooltip", () => ({TextTooltip: {default: () => ({terminate() {}})}}))

import {ClipLane} from "./ClipLane"
import {ClipsHeader} from "./ClipsHeader"

let frame: FrameRequestCallback
let timestamp = 0
const flush = () => frame(timestamp += 20)
const owner = {requestAnimationFrame: (callback: FrameRequestCallback) => {frame = callback; return 1},
    cancelAnimationFrame() {}} as unknown as WindowProxy

afterEach(() => AnimationFrame.terminate())

const setup = (component: "lane" | "header") => {
    const lifecycle = new Terminator()
    const clips = new ClipsView(new DefaultObservableValue(true))
    const clip = {isSelected: false, box: {subscribeDeletion: () => Terminable.Empty}}
    const adapter = {listIndex: 0, clips: {subscribeChanges: () => Terminable.Empty,
        collection: {adapters: () => [clip], catchupAndSubscribe: () => Terminable.Empty}}}
    const service = {project: {engine: {}, rootBoxAdapter: {}}, timeline: {clips}}
    const manager = {currentClipModifier: Option.None, getByIndex: () => Option.wrap({trackBoxAdapter: adapter})}
    const element = component === "lane"
        ? ClipLane({lifecycle, service, adapter, trackManager: manager} as unknown as Parameters<typeof ClipLane>[0])
        : ClipsHeader({lifecycle, service} as unknown as Parameters<typeof ClipsHeader>[0])
    AnimationFrame.start(owner)
    flush()
    return {clips, lifecycle, element: element as unknown as InstanceType<typeof harness.Element>}
}

describe.each(["lane", "header"] as const)("clip %s visibility", component => {
    it("does not recreate cells after hiding with a resize queued", () => {
        const {clips, lifecycle, element} = setup(component)
        const permanentChildren = component === "header" ? 1 : 0
        expect(element.children).toHaveLength(permanentChildren + 3)
        if (component === "lane") {expect(element.children[0].textContent).toBe("clip")}
        clips.setCount(0, 100)
        clips.visible.setValue(false)
        expect(element.children).toHaveLength(permanentChildren)
        flush()
        expect(element.children).toHaveLength(permanentChildren)
        clips.visible.setValue(true)
        flush()
        expect(element.children).toHaveLength(permanentChildren + 1)
        lifecycle.terminate()
    })
    it("does not recreate cells after disposal with a resize queued", () => {
        const {clips, lifecycle, element} = setup(component)
        const permanentChildren = component === "header" ? 1 : 0
        clips.setCount(1, 100)
        lifecycle.terminate()
        flush()
        expect(element.children).toHaveLength(permanentChildren)
    })
})
