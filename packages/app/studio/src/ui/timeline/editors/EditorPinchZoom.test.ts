import type {TimelineRange} from "@opendaw/studio-core"
import {describe, expect, it, vi} from "vitest"
import {WheelScaling} from "@/ui/timeline/WheelScaling"
import {installEditorPinchZoom} from "./EditorPinchZoom"

vi.mock("@opendaw/lib-dom", () => ({Events: {
    subscribe: (target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        target.addEventListener(type, listener, options)
        return {terminate: () => target.removeEventListener(type, listener, options)}
    }
}}))
vi.mock("@/ui/timeline/WheelScaling", () => ({WheelScaling: {apply: vi.fn()}}))

const setup = (enabled = true) => {
    vi.mocked(WheelScaling.apply).mockClear()
    const body = new EventTarget() as unknown as HTMLElement
    const axis = {getBoundingClientRect: () => ({left: 200, right: 600})} as HTMLElement
    const range = {} as TimelineRange
    const subscription = installEditorPinchZoom(body, axis, range, () => enabled)
    const wheel = (ctrlKey: boolean, clientX = 240) => {
        const event = Object.assign(new Event("wheel", {cancelable: true}), {ctrlKey, clientX})
        body.dispatchEvent(event)
        return event
    }
    return {axis, range, wheel, subscription}
}

describe("editor pinch zoom", () => {
    it("zooms pinch events once around the ruler coordinates and preserves normal scrolling", () => {
        vi.mocked(WheelScaling.apply).mockClear()
        const {axis, range, wheel, subscription} = setup()
        expect(wheel(false).defaultPrevented).toBe(false)
        expect(wheel(true, 150).defaultPrevented).toBe(false)
        const event = wheel(true)
        expect(event.defaultPrevented).toBe(true)
        expect(WheelScaling.apply).toHaveBeenCalledExactlyOnceWith(axis, range, event)
        subscription.terminate()
    })
    it("ignores pinch without an open editor", () => {
        const {wheel, subscription} = setup(false)
        expect(wheel(true).defaultPrevented).toBe(false)
        expect(WheelScaling.apply).not.toHaveBeenCalled()
        subscription.terminate()
    })
})
