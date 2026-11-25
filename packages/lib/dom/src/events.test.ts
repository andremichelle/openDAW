import {afterEach, describe, expect, it, vi} from "vitest"
import {Events} from "./events"

// node has no PointerEvent: a plain event carrying the coordinates the listener reads
const press = (target: EventTarget, type: string, clientX: number, clientY: number, time: number,
               pointerType: string = "mouse"): void => {
    vi.spyOn(performance, "now").mockReturnValue(time)
    target.dispatchEvent(Object.assign(new Event(type, {cancelable: true}), {clientX, clientY, pointerType}))
}

describe("Events double press", () => {
    afterEach(() => vi.restoreAllMocks())
    it("fires for two quick presses on the same spot", () => {
        const target = new EventTarget()
        const listener = vi.fn()
        Events.subscribeDblDwn(target, listener)
        press(target, "pointerdown", 100, 100, 1000)
        press(target, "pointerdown", 101, 100, 1100)
        expect(listener).toHaveBeenCalledTimes(1)
    })
    it("does not fire for two quick presses on different spots", () => {
        const target = new EventTarget()
        const listener = vi.fn()
        Events.subscribeDblDwn(target, listener)
        press(target, "pointerdown", 100, 100, 1000)
        press(target, "pointerdown", 300, 180, 1100)
        expect(listener).not.toHaveBeenCalled()
    })
    it("does not fire for two slow presses on the same spot", () => {
        const target = new EventTarget()
        const listener = vi.fn()
        Events.subscribeDblDwn(target, listener)
        press(target, "pointerdown", 100, 100, 1000)
        press(target, "pointerdown", 100, 100, 1500)
        expect(listener).not.toHaveBeenCalled()
    })
    it("allows a finger to land a little further off for a double tap", () => {
        const target = new EventTarget()
        const listener = vi.fn()
        Events.subscribeDblDwn(target, listener)
        press(target, "pointerdown", 100, 100, 1000, "touch")
        press(target, "pointerdown", 112, 108, 1100, "touch")
        expect(listener).toHaveBeenCalledTimes(1)
        press(target, "pointerdown", 100, 100, 2000, "mouse")
        press(target, "pointerdown", 112, 108, 2100, "mouse")
        expect(listener, "a mouse stays precise").toHaveBeenCalledTimes(1)
    })
    it("fires once for a triple click", () => {
        const target = new EventTarget()
        const listener = vi.fn()
        Events.subscribeDblDwn(target, listener)
        press(target, "pointerdown", 100, 100, 1000)
        press(target, "pointerdown", 100, 100, 1100)
        press(target, "pointerdown", 100, 100, 1200)
        expect(listener).toHaveBeenCalledTimes(1)
    })
    it("applies the same rules to releases", () => {
        const target = new EventTarget()
        const listener = vi.fn()
        Events.subscribeDblUp(target, listener)
        press(target, "pointerup", 100, 100, 1000)
        press(target, "pointerup", 300, 180, 1100)
        expect(listener).not.toHaveBeenCalled()
        press(target, "pointerup", 300, 181, 1200)
        expect(listener).toHaveBeenCalledTimes(1)
    })
})
