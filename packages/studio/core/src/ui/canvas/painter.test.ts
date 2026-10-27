import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

const harness = vi.hoisted(() => ({frames: new Set<() => void>(), resizes: new Set<(entry: ResizeObserverEntry) => void>()}))
vi.mock("@opendaw/lib-dom", () => ({
    AnimationFrame: {add: (frame: () => void) => {
        harness.frames.add(frame)
        return {terminate: () => harness.frames.delete(frame)}
    }},
    Html: {watchResize: (_target: Element, callback: (entry: ResizeObserverEntry) => void) => {
        harness.resizes.add(callback)
        return {terminate: () => harness.resizes.delete(callback)}
    }}
}))
import {CanvasPainter, CanvasUnitPainter} from "./painter"
import {LinearScale} from "./scale"

// the painter reads only the content box of an entry
const observation = (width: number, height: number) => ({contentRect: {width, height}}) as ResizeObserverEntry
// `layout` is where the browser laid the canvas out; `observe` delivers that size the way a ResizeObserver does after layout
const createCanvas = () => {
    const canvas = document.createElement("canvas")
    const layout = {width: 0, height: 0, reads: 0}
    const resets = {count: 0, width: 0, height: 0}
    Object.defineProperty(canvas, "clientWidth", {get: () => {layout.reads++; return layout.width}})
    Object.defineProperty(canvas, "clientHeight", {get: () => {layout.reads++; return layout.height}})
    Object.defineProperty(canvas, "width", {get: () => resets.width, set: (value: number) => {resets.count++; resets.width = Math.trunc(value)}})
    Object.defineProperty(canvas, "height", {get: () => resets.height, set: (value: number) => {resets.height = Math.trunc(value)}})
    const layOut = (width: number, height: number) => {
        layout.width = width
        layout.height = height
    }
    const observe = () => harness.resizes.forEach(callback => callback(observation(layout.width, layout.height)))
    const resize = (width: number, height: number) => {
        layOut(width, height)
        observe()
    }
    return {canvas, layout, resets, layOut, observe, resize}
}
const runFrame = () => [...harness.frames].forEach(frame => frame())

beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D)
    vi.stubGlobal("devicePixelRatio", 2)
})
afterEach(() => {
    harness.frames.clear()
    harness.resizes.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("CanvasPainter reads no layout in an animation frame", () => {
    it("once the resize observer has reported a size, a frame does not read the canvas size", () => {
        const {canvas, layout, resize} = createCanvas()
        const painter = new CanvasPainter(canvas, () => {})
        resize(300, 40)
        runFrame()
        painter.requestUpdate()
        runFrame()
        expect(layout.reads).toBe(0)
        painter.terminate()
    })
    it("an idle painter reads nothing in a frame", () => {
        const {canvas, layout, resize} = createCanvas()
        const painter = new CanvasPainter(canvas, () => {})
        resize(300, 40)
        runFrame()
        const reads = layout.reads
        runFrame()
        runFrame()
        expect(layout.reads).toBe(reads)
        painter.terminate()
    })
    it("a new canvas paints once, the first observation of the same size does not paint it again", () => {
        const {canvas, layOut, observe} = createCanvas()
        const render = vi.fn()
        const painter = new CanvasPainter(canvas, render)
        layOut(300, 40)
        runFrame()
        observe()
        runFrame()
        expect(render).toHaveBeenCalledTimes(1)
        painter.terminate()
    })
})

// behaviour every caller relies on, the same on main and with the fix
describe("CanvasPainter keeps its contract", () => {
    it("a new canvas paints in its first frame, before any observation arrived", () => {
        const {canvas, layOut} = createCanvas()
        const sizes: Array<[number, number, boolean]> = []
        const painter = new CanvasPainter(canvas, ({width, height, isResized}) => sizes.push([width, height, isResized]))
        layOut(300, 40)
        runFrame()
        expect(sizes).toEqual([[300, 40, true]])
        painter.terminate()
    })
    it("a canvas the observer never reports (a pop-out while the main window is hidden) paints at its laid out size", () => {
        const {canvas, layOut} = createCanvas()
        const sizes: Array<[number, number, boolean]> = []
        const painter = new CanvasPainter(canvas, ({width, height, isResized}) => sizes.push([width, height, isResized]))
        layOut(300, 40)
        runFrame()
        layOut(420, 60)
        painter.requestUpdate()
        runFrame()
        expect(sizes).toEqual([[300, 40, true], [420, 60, true]])
        painter.terminate()
    })
    it("a resize paints at the next frame, at the new size", () => {
        const {canvas, resize} = createCanvas()
        const sizes: Array<[number, number, boolean]> = []
        const painter = new CanvasPainter(canvas, ({width, height, isResized}) => sizes.push([width, height, isResized]))
        resize(300, 40)
        runFrame()
        resize(420, 40)
        runFrame()
        runFrame()
        expect(sizes).toEqual([[300, 40, true], [420, 40, true]])
        painter.terminate()
    })
    it("paints at the laid out size, scaled by devicePixelRatio", () => {
        const {canvas, resets, resize} = createCanvas()
        const seen: Array<Array<number | boolean>> = []
        const painter = new CanvasPainter(canvas, ({width, height, actualWidth, actualHeight, devicePixelRatio, isResized}) =>
            seen.push([width, height, actualWidth, actualHeight, devicePixelRatio, isResized]))
        resize(300, 40)
        runFrame()
        expect(seen).toEqual([[300, 40, 600, 80, 2, true]])
        expect([resets.width, resets.height]).toEqual([600, 80])
        painter.terminate()
    })
    it("an update at the same size is not a resize, but still resets the canvas", () => {
        const {canvas, resets, resize} = createCanvas()
        const resized: Array<boolean> = []
        const painter = new CanvasPainter(canvas, ({isResized}) => resized.push(isResized))
        resize(300, 40)
        runFrame()
        const count = resets.count
        painter.requestUpdate()
        runFrame()
        expect(resized).toEqual([true, false])
        expect(resets.count).toBe(count + 1)
        painter.terminate()
    })
    it("a devicePixelRatio change alone is a resize at the next update", () => {
        vi.stubGlobal("devicePixelRatio", 1)
        const {canvas, resets, resize} = createCanvas()
        const resized: Array<boolean> = []
        const painter = new CanvasPainter(canvas, ({isResized}) => resized.push(isResized))
        resize(300, 40)
        runFrame()
        vi.stubGlobal("devicePixelRatio", 2)
        painter.requestUpdate()
        runFrame()
        expect(resized).toEqual([true, true])
        expect(resets.width).toBe(600)
        painter.terminate()
    })
    it("a canvas without size (detached, display none) is not painted until it has one", () => {
        const {canvas, resize} = createCanvas()
        const render = vi.fn()
        const painter = new CanvasPainter(canvas, render)
        resize(0, 0)
        runFrame()
        painter.requestUpdate()
        runFrame()
        expect(render).not.toHaveBeenCalled()
        resize(300, 40)
        runFrame()
        expect(render).toHaveBeenCalledTimes(1)
        painter.terminate()
    })
    it("CanvasUnitPainter maps units onto the device pixel size", () => {
        const {canvas, resize} = createCanvas()
        const positions: Array<number> = []
        const painter = new CanvasUnitPainter(canvas, new LinearScale(0, 10), new LinearScale(0, 1), unitPainter =>
            positions.push(unitPainter.unitToX(10), unitPainter.unitToY(0)))
        resize(300, 40)
        runFrame()
        expect(positions).toEqual([600, 80])
        painter.terminate()
    })
    it("terminate stops the frame and the observer", () => {
        const {canvas, resize} = createCanvas()
        const render = vi.fn()
        new CanvasPainter(canvas, render).terminate()
        resize(300, 40)
        runFrame()
        expect(render).not.toHaveBeenCalled()
        expect([harness.frames.size, harness.resizes.size]).toEqual([0, 0])
    })
})
