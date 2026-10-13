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
