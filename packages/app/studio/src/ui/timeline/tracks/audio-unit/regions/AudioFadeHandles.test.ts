import {describe, expect, it} from "vitest"
import {AudioFadeHandles} from "./AudioFadeHandles"
const range = {unitToX: (value: number) => value}
const fading = {in: 0, out: 0, inSlope: 0.5, outSlope: 0.5}
describe("visible audio fade handles", () => {
    it("doubles the former visible size and grab radius", () => {
        expect(AudioFadeHandles.radius).toBeGreaterThanOrEqual(3)
        expect(AudioFadeHandles.hitRadius).toBeGreaterThanOrEqual(6)
    })
    it("keeps zero-fade handles inside clip edges", () => {
        expect(AudioFadeHandles.positions(range, fading, 0, 100)).toEqual({inX: 5, outX: 95})
    })
    it("matches scaled fades and keeps short clips in bounds", () => {
        expect(AudioFadeHandles.positions(range, {...fading, in: 80, out: 80}, 0, 100)).toEqual({inX: 50, outX: 50})
        expect(AudioFadeHandles.positions(range, fading, 0, 4)).toEqual({inX: 2, outX: 2})
    })
    it("shows a midpoint diamond only for nonzero fades", () => {
        expect(AudioFadeHandles.slopeHandles(range, fading, 0, 100, 55)).toEqual([])
        expect(AudioFadeHandles.slopeHandles(range, {...fading, in: 40, out: 20}, 0, 100, 55))
            .toEqual([{part: "fading-in-slope", x: 20, y: 35}, {part: "fading-out-slope", x: 90, y: 35}])
    })
    it("places diamonds on nonlinear and overlapping fade curves", () => {
        const handles = AudioFadeHandles.slopeHandles(range, {...fading, in: 80, out: 80, inSlope: 0.25, outSlope: 0.75}, 0, 100, 55)
        expect(handles[0].x).toBe(25)
        expect(handles[0].y).toBeCloseTo(45)
        expect(handles[1].x).toBe(75)
        expect(handles[1].y).toBeCloseTo(45)
    })
    it.each([true, false])("moves the diamond in both screen axes and keeps it on the curve, fadeIn=%s", fadeIn => {
        for (const [deltaX, deltaY] of [[20, 0], [-20, 0], [0, 8], [20, 8], [-20, -8]]) {
            const point = AudioFadeHandles.curveAfterDrag(0.5, 0.5, deltaX, deltaY, 100, 55, fadeIn)
            const config = {...fading, in: fadeIn ? 100 : 0, out: fadeIn ? 0 : 100,
                inSlope: point.slope, outSlope: point.slope}
            const anchors = {in: point.position, out: point.position}
            const [handle] = AudioFadeHandles.slopeHandles(range, config, 0, 200, 55, anchors)
            expect(handle.x).toBeCloseTo((fadeIn ? 50 : 150) + deltaX)
            expect(handle.y).toBeCloseTo(35 + deltaY)
        }
    })
    it("uses the saved anchor as the next drag origin and follows zoom", () => {
        const first = AudioFadeHandles.curveAfterDrag(0.5, 0.5, 20, 8, 100, 55, true)
        const second = AudioFadeHandles.curveAfterDrag(first.slope, first.position, -10, -4, 100, 55, true)
        const combined = AudioFadeHandles.curveAfterDrag(0.5, 0.5, 10, 4, 100, 55, true)
        expect(second.position).toBeCloseTo(combined.position)
        expect(second.slope).toBeCloseTo(combined.slope)
        const zoomed = AudioFadeHandles.curveAfterDrag(0.5, 0.5, 40, 8, 200, 55, true)
        expect(zoomed.position).toBeCloseTo(first.position)
        expect(zoomed.slope).toBeCloseTo(first.slope)
    })
    it("bounds the point and curve for extreme or tiny drags", () => {
        for (const delta of [-1000, 1000]) {
            const point = AudioFadeHandles.curveAfterDrag(0.5, 0.5, delta, delta, 0, 0, true)
            expect(point.position).toBeGreaterThanOrEqual(0.02)
            expect(point.position).toBeLessThanOrEqual(0.98)
            expect(point.slope).toBeGreaterThanOrEqual(0.001)
            expect(point.slope).toBeLessThanOrEqual(0.999)
        }
    })
})
