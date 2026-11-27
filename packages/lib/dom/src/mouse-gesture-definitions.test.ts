import {afterEach, describe, expect, it, vi} from "vitest"
import {MouseGesture} from "./mouse-gesture"
import {MouseGestureDefinitions, MouseGestureValidator} from "./mouse-gesture-definitions"

const createDefinitions = () => ({
    zoom: {gesture: MouseGesture.of("wheel", {ctrl: true}), description: "Zoom"},
    pan: {gesture: MouseGesture.of("wheel", {shift: true}), description: "Pan"},
    drag: {gesture: MouseGesture.of("middle-drag"), description: "Drag"}
}) satisfies MouseGestureDefinitions

describe("MouseGestureDefinitions", () => {
    it("copies into independent gestures", () => {
        const defs = createDefinitions()
        const copy = MouseGestureDefinitions.copy(defs)
        expect(copy.zoom.gesture).not.toBe(defs.zoom.gesture)
        expect(copy.zoom.gesture.equals(defs.zoom.gesture)).toBe(true)
        expect(copy.zoom.description).toBe("Zoom")
        copy.zoom.gesture.overrideWith(MouseGesture.of("middle-drag", {alt: true}))
        expect(defs.zoom.gesture.equals(MouseGesture.of("wheel", {ctrl: true}))).toBe(true)
    })
    it("copies into the target in place", () => {
        const source = createDefinitions()
        const target = createDefinitions()
        const targetGesture = target.pan.gesture
        source.pan.gesture.overrideWith(MouseGesture.of("wheel", {alt: true}))
        MouseGestureDefinitions.copyInto(source, target)
        expect(target.pan.gesture).toBe(targetGesture)
        expect(target.pan.gesture.equals(MouseGesture.of("wheel", {alt: true}))).toBe(true)
        expect(target.pan.gesture).not.toBe(source.pan.gesture)
    })
    it("round trips through JSON", () => {
        const source = createDefinitions()
        source.zoom.gesture.overrideWith(MouseGesture.of("middle-drag", {ctrl: true}))
        source.drag.gesture.overrideWith(MouseGesture.of("wheel", {alt: true, shift: true}))
        const target = createDefinitions()
        MouseGestureDefinitions.fromJSON(target, MouseGestureDefinitions.toJSON(source))
        expect(target.zoom.gesture.equals(source.zoom.gesture)).toBe(true)
        expect(target.pan.gesture.equals(source.pan.gesture)).toBe(true)
        expect(target.drag.gesture.equals(source.drag.gesture)).toBe(true)
    })
    it("ignores unknown keys and malformed entries and applies the rest", () => {
        const defs = createDefinitions()
        MouseGestureDefinitions.fromJSON(defs, {
            unknown: {input: "wheel", ctrl: false, shift: false, alt: true},
            zoom: {input: "left-drag", ctrl: true, shift: false, alt: false},
            pan: "wheel",
            drag: {input: "middle-drag", ctrl: false, shift: true, alt: false}
        })
        expect(defs.zoom.gesture.equals(MouseGesture.of("wheel", {ctrl: true}))).toBe(true)
        expect(defs.pan.gesture.equals(MouseGesture.of("wheel", {shift: true}))).toBe(true)
        expect(defs.drag.gesture.equals(MouseGesture.of("middle-drag", {shift: true}))).toBe(true)
    })
    it("ignores values that are not an object", () => {
        const defs = createDefinitions()
        MouseGestureDefinitions.fromJSON(defs, null)
        MouseGestureDefinitions.fromJSON(defs, [])
        expect(defs.zoom.gesture.equals(MouseGesture.of("wheel", {ctrl: true}))).toBe(true)
    })
})

describe("MouseGestureValidator", () => {
    afterEach(() => vi.unstubAllGlobals())
    it("finds no conflicts in distinct gestures", () => {
        expect(MouseGestureValidator.conflicts(createDefinitions())).toEqual([])
    })
    it("finds a pair of equal gestures", () => {
        const defs = createDefinitions()
        defs.drag.gesture.overrideWith(MouseGesture.of("wheel", {ctrl: true}))
        expect(MouseGestureValidator.conflicts(defs)).toEqual([["zoom", "drag"]])
    })
    it("ignores the same input with different modifiers and the same modifiers with a different input", () => {
        const defs = {
            a: {gesture: MouseGesture.of("wheel", {ctrl: true}), description: "a"},
            b: {gesture: MouseGesture.of("wheel", {alt: true}), description: "b"},
            c: {gesture: MouseGesture.of("middle-drag", {ctrl: true}), description: "c"}
        }
        expect(MouseGestureValidator.conflicts(defs)).toEqual([])
    })
    it("returns its argument and alerts once per conflict", () => {
        const alert = vi.fn()
        vi.stubGlobal("alert", alert)
        const defs = createDefinitions()
        defs.pan.gesture.overrideWith(MouseGesture.of("wheel", {ctrl: true}))
        defs.drag.gesture.overrideWith(MouseGesture.of("wheel", {ctrl: true}))
        expect(MouseGestureValidator.validate(defs)).toBe(defs)
        expect(alert).toHaveBeenCalledTimes(3)
    })
    it("does not alert without conflicts", () => {
        const alert = vi.fn()
        vi.stubGlobal("alert", alert)
        MouseGestureValidator.validate(createDefinitions())
        expect(alert).not.toHaveBeenCalled()
    })
})
