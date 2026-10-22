import {afterEach, describe, expect, it, vi} from "vitest"

const harness = vi.hoisted(() => ({
    listeners: [] as Array<{target: unknown, type: string, listener: (event: unknown) => void}>,
    frames: [] as Array<() => void>,
    owner: {}
}))
vi.mock("@/ui/surface/Surface.tsx", () => ({Surface: {get: () => ({owner: {document: harness.owner}})}}))
vi.mock("@opendaw/lib-dom", () => ({
    Events: {subscribe: (target: unknown, type: string, listener: (event: unknown) => void) => {
        const entry = {target, type, listener}
        harness.listeners.push(entry)
        return {terminate: () => harness.listeners.splice(harness.listeners.indexOf(entry), 1)}
    }},
    AnimationFrame: {add: (frame: () => void) => {
        harness.frames.push(frame)
        return {terminate: () => harness.frames.splice(harness.frames.indexOf(frame), 1)}
    }}
}))
import {installAutoScroll} from "./AutoScroll"
import {Config} from "./timeline/Config"

class TestElement {
    constructor(readonly resize: boolean) {}
    closest(selector: string) {return this.resize && selector === ".track-resizer" ? this : null}
    getBoundingClientRect() {return {top: 0, left: 0, right: 100, bottom: 100}}
}

afterEach(() => {
    harness.listeners.length = 0
    harness.frames.length = 0
    vi.unstubAllGlobals()
})

describe("timeline resize auto-scroll exclusion", () => {
    it("does not arm either ancestor scroller for a resize handle", () => {
        vi.stubGlobal("Element", TestElement)
        const resizer = new TestElement(true)
        const scroller = vi.fn()
        const subscriptions = [new TestElement(false), new TestElement(false)].map(target =>
            installAutoScroll(target as unknown as Element, scroller, {ignorePointerSelector: ".track-resizer"}))
        harness.listeners.filter(entry => entry.type === "pointerdown")
            .forEach(entry => entry.listener({target: resizer}))
        expect(harness.listeners.filter(entry => entry.target === harness.owner)).toHaveLength(0)
        expect(harness.frames).toHaveLength(0)
        expect(scroller).not.toHaveBeenCalled()
        subscriptions.forEach(subscription => subscription.terminate())
    })
    it("still scrolls ordinary drags and stops on release", () => {
        vi.stubGlobal("Element", TestElement)
        const target = new TestElement(false)
        const scroller = vi.fn()
        const subscription = installAutoScroll(target as unknown as Element, scroller,
            {ignorePointerSelector: ".track-resizer"})
        harness.listeners.find(entry => entry.type === "pointerdown")?.listener({target})
        harness.listeners.find(entry => entry.type === "pointermove")?.listener({clientX: 50, clientY: 130})
        harness.frames.forEach(frame => frame())
        expect(scroller).toHaveBeenCalledWith(0, 30)
        harness.listeners.find(entry => entry.type === "pointerup")?.listener({})
        expect(harness.frames).toHaveLength(0)
        subscription.terminate()
    })
})

// a knob or button in a track header (volume, pan, mute, solo) is a value drag, not a content drag: no scrolling
class ControlElement {
    constructor(readonly inControls: boolean) {}
    closest(selector: string) {
        return this.inControls && selector.split(",").map(part => part.trim()).includes("[data-no-auto-scroll]") ? this : null
    }
    getBoundingClientRect() {return {top: 0, left: 0, right: 100, bottom: 100}}
}

describe("timeline auto-scroll leaves the track header controls alone", () => {
    it("does not scroll while a knob is dragged past the edge", () => {
        vi.stubGlobal("Element", ControlElement)
        const scroller = vi.fn()
        const subscription = installAutoScroll(new ControlElement(false) as unknown as Element, scroller,
            {ignorePointerSelector: Config.AutoScrollIgnore})
        harness.listeners.find(entry => entry.type === "pointerdown")?.listener({target: new ControlElement(true)})
        expect(harness.listeners.find(entry => entry.type === "pointermove")).toBeUndefined()
        expect(scroller).not.toHaveBeenCalled()
        subscription.terminate()
    })
})
