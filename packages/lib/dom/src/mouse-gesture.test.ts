import {afterEach, describe, expect, it, vi} from "vitest"
import {Browser} from "./browser"
import {MouseGesture} from "./mouse-gesture"

// node has no WheelEvent or PointerEvent: plain objects carry the fields MouseGesture reads
const modifiers = (patch: Partial<MouseGesture.Modifiers> = {}): MouseGesture.Modifiers =>
    ({ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch})

const inputs: ReadonlyArray<MouseGesture.Input> = ["wheel", "middle-drag"]
const flags: ReadonlyArray<boolean> = [false, true]

describe("MouseGesture", () => {
    afterEach(() => vi.restoreAllMocks())
    it("defaults to no modifiers", () => {
        const gesture = MouseGesture.of("wheel")
        expect(gesture.input).toBe("wheel")
        expect(gesture.ctrl).toBe(false)
        expect(gesture.shift).toBe(false)
        expect(gesture.alt).toBe(false)
    })
    it("reflects the arguments in its getters", () => {
        const gesture = MouseGesture.of("middle-drag", {ctrl: true, shift: true, alt: true})
        expect(gesture.input).toBe("middle-drag")
        expect(gesture.ctrl).toBe(true)
        expect(gesture.shift).toBe(true)
        expect(gesture.alt).toBe(true)
    })
    it("round trips through JSON for every input and modifier combination", () => {
        for (const input of inputs) {
            for (const ctrl of flags) {
                for (const shift of flags) {
                    for (const alt of flags) {
                        const gesture = MouseGesture.of(input, {ctrl, shift, alt})
                        const restored = MouseGesture.fromJSON(gesture.toJSON()).unwrap("fromJSON")
                        expect(restored.equals(gesture)).toBe(true)
                    }
                }
            }
        }
    })
    it("rejects malformed JSON", () => {
        expect(MouseGesture.fromJSON(null).isEmpty()).toBe(true)
        expect(MouseGesture.fromJSON([]).isEmpty()).toBe(true)
        expect(MouseGesture.fromJSON("wheel").isEmpty()).toBe(true)
        expect(MouseGesture.fromJSON({input: "left-drag", ctrl: false, shift: false, alt: false}).isEmpty()).toBe(true)
        expect(MouseGesture.fromJSON({input: "wheel", ctrl: "yes", shift: false, alt: false}).isEmpty()).toBe(true)
        expect(MouseGesture.fromJSON({input: "wheel", ctrl: false, shift: 1, alt: false}).isEmpty()).toBe(true)
        expect(MouseGesture.fromJSON({input: "wheel", ctrl: false, shift: false}).isEmpty()).toBe(true)
    })
    it("matches the exact modifiers only", () => {
        vi.spyOn(Browser, "isMacOS").mockReturnValue(false)
        const gesture = MouseGesture.of("wheel", {ctrl: true})
        expect(gesture.matches("wheel", modifiers({ctrlKey: true}))).toBe(true)
        expect(gesture.matches("wheel", modifiers({ctrlKey: true, shiftKey: true}))).toBe(false)
        expect(gesture.matches("wheel", modifiers())).toBe(false)
        expect(gesture.matches("middle-drag", modifiers({ctrlKey: true}))).toBe(false)
    })
    it("treats meta as ctrl on macOS", () => {
        vi.spyOn(Browser, "isMacOS").mockReturnValue(true)
        const gesture = MouseGesture.of("wheel", {ctrl: true})
        expect(gesture.matches("wheel", modifiers({metaKey: true}))).toBe(true)
        expect(gesture.matches("wheel", modifiers({ctrlKey: true}))).toBe(false)
        expect(MouseGesture.fromWheel(modifiers({metaKey: true})).ctrl).toBe(true)
        expect(MouseGesture.fromWheel(modifiers({ctrlKey: true})).ctrl).toBe(false)
    })
    it("keeps the modifiers of a wheel event", () => {
        vi.spyOn(Browser, "isMacOS").mockReturnValue(false)
        const gesture = MouseGesture.fromWheel(modifiers({ctrlKey: true, altKey: true}))
        expect(gesture.equals(MouseGesture.of("wheel", {ctrl: true, alt: true}))).toBe(true)
    })
    it("creates a middle drag only for the middle button", () => {
        vi.spyOn(Browser, "isMacOS").mockReturnValue(false)
        const gesture = MouseGesture.fromPointer({...modifiers({shiftKey: true}), button: 1}).unwrap("fromPointer")
        expect(gesture.equals(MouseGesture.of("middle-drag", {shift: true}))).toBe(true)
        expect(MouseGesture.fromPointer({...modifiers(), button: 0}).isEmpty()).toBe(true)
        expect(MouseGesture.fromPointer({...modifiers(), button: 2}).isEmpty()).toBe(true)
    })
    it("compares by input and modifiers", () => {
        expect(MouseGesture.of("wheel", {alt: true}).equals(MouseGesture.of("wheel", {alt: true}))).toBe(true)
        expect(MouseGesture.of("wheel", {alt: true}).equals(MouseGesture.of("wheel"))).toBe(false)
        expect(MouseGesture.of("wheel").equals(MouseGesture.of("middle-drag"))).toBe(false)
    })
    it("copies into an independent instance", () => {
        const gesture = MouseGesture.of("wheel", {shift: true})
        const copy = gesture.copy()
        expect(copy).not.toBe(gesture)
        expect(copy.equals(gesture)).toBe(true)
        copy.overrideWith(MouseGesture.of("middle-drag"))
        expect(gesture.equals(MouseGesture.of("wheel", {shift: true}))).toBe(true)
    })
    it("notifies once when overridden with a different gesture", () => {
        const gesture = MouseGesture.of("wheel")
        const observer = vi.fn()
        gesture.subscribe(observer)
        gesture.overrideWith(MouseGesture.of("wheel", {ctrl: true}))
        expect(observer).toHaveBeenCalledTimes(1)
        expect(gesture.ctrl).toBe(true)
    })
    it("does not notify when overridden with an equal gesture", () => {
        const gesture = MouseGesture.of("wheel", {ctrl: true})
        const observer = vi.fn()
        gesture.subscribe(observer)
        gesture.overrideWith(MouseGesture.of("wheel", {ctrl: true}))
        expect(observer).not.toHaveBeenCalled()
    })
    it("formats with words joined by + on other platforms", () => {
        vi.spyOn(Browser, "isMacOS").mockReturnValue(false)
        expect(MouseGesture.of("wheel").format()).toEqual(["Wheel"])
        expect(MouseGesture.of("middle-drag", {ctrl: true, shift: true, alt: true}).format())
            .toEqual(["Shift", "+", "Alt", "+", "Ctrl", "+", "Middle Drag"])
    })
    it("formats with symbols on macOS", () => {
        vi.spyOn(Browser, "isMacOS").mockReturnValue(true)
        expect(MouseGesture.of("wheel", {ctrl: true}).format()).toEqual(["⌘", "Wheel"])
        expect(MouseGesture.of("middle-drag", {ctrl: true, shift: true, alt: true}).format())
            .toEqual(["⇧", "⌥", "⌘", "Middle Drag"])
    })
})
