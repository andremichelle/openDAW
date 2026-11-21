import {StudioPreferences} from "@opendaw/studio-core"
import {beforeEach, describe, expect, it, vi} from "vitest"
import {installEditorClickSeeking} from "./EditorNavigation"

vi.mock("@opendaw/studio-core", () => ({StudioPreferences: {settings: {timeline: {"click-to-seek": true}}}}))
beforeEach(() => {StudioPreferences.settings.timeline["click-to-seek"] = true})

vi.mock("@opendaw/lib-dom", () => ({Events: {
    subscribe: (target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        target.addEventListener(type, listener, options)
        return {terminate: () => target.removeEventListener(type, listener, options)}
    }
}}))

const setup = (enabled = true, canSeek: () => boolean = () => true) => {
    const owner = new EventTarget()
    const body = Object.assign(new EventTarget(), {
        ownerDocument: {defaultView: owner}, getBoundingClientRect: () => ({left: 100})
    }) as unknown as HTMLElement
    const axis = {getBoundingClientRect: () => ({left: 200, right: 600, width: 400})} as HTMLElement
    const range = {xToUnit: (x: number) => 1000 + x * 10}
    const snapping = {round: (unit: number) => Math.round(unit / 100) * 100}
    const seek = vi.fn()
    const subscription = installEditorClickSeeking(body, axis, range as never, snapping as never, () => enabled, seek, canSeek)
    const pointer = (type: string, clientX: number) => {
        const event = Object.assign(new Event(type), {pointerId: 1, isPrimary: true, button: 0,
            clientX, clientY: 20, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false})
        ;(type === "pointerdown" ? body : owner).dispatchEvent(event)
    }
    return {body, axis, range, seek, pointer, subscription}
}

describe("editor click seeking", () => {
    it("does not seek when the preference is off or the transport is playing", () => {
        let playing = false
        const {pointer, seek, subscription} = setup(true, () => !playing)
        StudioPreferences.settings.timeline["click-to-seek"] = false
        pointer("pointerdown", 243)
        pointer("pointerup", 243)
        StudioPreferences.settings.timeline["click-to-seek"] = true
        playing = true
        pointer("pointerdown", 243)
        pointer("pointerup", 243)
        expect(seek).not.toHaveBeenCalled()
        subscription.terminate()
    })
    it("seeks from ruler-aligned coordinates with editor snapping", () => {
        const {pointer, seek, subscription} = setup()
        pointer("pointerdown", 243)
        pointer("pointerup", 243)
        expect(seek).toHaveBeenCalledExactlyOnceWith(1400)
        subscription.terminate()
    })
    it("excludes left headers and ignores drags", () => {
        const {pointer, seek, subscription} = setup()
        pointer("pointerdown", 150)
        pointer("pointerup", 150)
        pointer("pointerdown", 243)
        pointer("pointermove", 280)
        pointer("pointerup", 243)
        expect(seek).not.toHaveBeenCalled()
        subscription.terminate()
    })
    it("does nothing without an open editor", () => {
        const {pointer, seek, subscription} = setup(false)
        pointer("pointerdown", 243)
        pointer("pointerup", 243)
        expect(seek).not.toHaveBeenCalled()
        subscription.terminate()
    })
})
