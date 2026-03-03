import {LoopableRegion, ValueEvent} from "@opendaw/lib-dsp"
import {asDefined, assert, Curve, Func, unitValue} from "@opendaw/lib-std"
import {TimelineRange} from "../../index"

export namespace ValueStreamRenderer {
    export const render = (context: CanvasRenderingContext2D,
                           range: TimelineRange,
                           generator: IterableIterator<ValueEvent>,
                           valueToY: Func<unitValue, number>,
                           contentColor: string,
                           alphaFill: unitValue,
                           anchor: unitValue,
                           {resultStart, resultEnd, rawStart: delta}: LoopableRegion.LoopCycle) => {
        const {done, value} = generator.next()
        if (done) {return}

        const unitToX = (unit: number): number => range.unitToX(unit + delta) * devicePixelRatio

        const path = new Path2D()

        const windowMin = resultStart - delta
        const windowMax = resultEnd - delta
        const xMin = unitToX(windowMin)
        const xMax = unitToX(windowMax)

        let notMoved: boolean = true // makes sure we start with a moveTo command
        let prev: ValueEvent = asDefined(value)
        for (const next of generator) {
            assert(prev !== next, "iterator error")
            const {position: p0, value: v0, interpolation} = prev
            const {position: p1, value: v1} = next
            const type = interpolation.type
            const x0 = unitToX(p0)
            const x1 = unitToX(p1)
            const y0 = valueToY(v0)
            const y1 = valueToY(v1)
            if (type === "none" || p1 - p0 === 0) { // hold and jumps to the next event's value
                if (notMoved) {
                    if (p1 > windowMax) {break} // leave the rest for after the loop
                    path.moveTo(xMin, y0) // move pen to window min
                    path.lineTo(x1, y0) // line to next event
                    notMoved = false
                }
                if (x1 > xMax) {break}
                path.lineTo(x1, y0) // hold value to the next event
                path.lineTo(x1, y1) // jump to the next event value
            } else if (type === "linear") {
                const ratio = (v1 - v0) / (p1 - p0)
                if (notMoved) {
                    path.moveTo(xMin, valueToY(p0 < windowMin ? v0 + ratio * (windowMin - p0) : v0)) // move pen to window min
                    if (p0 > windowMin) {path.lineTo(x0, y0)} // line to first event
                    notMoved = false
                }
                if (p1 > windowMax) {
                    path.lineTo(xMax, valueToY(v0 + ratio * (windowMax - p0))) // line to window max
                } else {
                    path.lineTo(x1, y1) // line to next event
                }
            } else if (type === "curve") {
                const cx0 = Math.max(x0, xMin)
                const cx1 = Math.min(x1, xMax)
                const definition: Curve.Definition = {slope: interpolation.slope, steps: x1 - x0, y0, y1}
                if (notMoved) {
                    if (p0 > windowMin) {
                        path.moveTo(xMin, y0) // move to window edge
                        path.lineTo(x0, y0) // draw the line to the first event
                    } else {
                        path.moveTo(cx0, Curve.valueAt(definition, cx0 - x0))
                    }
                    notMoved = false
                }
                // TODO We can optimise this by walking the Curve.coefficients
                for (let x = cx0; x <= cx1; x += 4) {
                    path.lineTo(x, Curve.valueAt(definition, x - x0))
                }
                path.lineTo(cx1, Curve.valueAt(definition, cx1 - x0))
            }
            prev = next
        }
        if (notMoved) {
            // we have not moved, so let's draw a straight line from min to max to respect the sole event
            path.moveTo(xMin, valueToY(prev.value))
            path.lineTo(xMax, valueToY(prev.value))
        } else if (prev.position < windowMax) {
            // hold value to the window max
            path.lineTo(xMax, valueToY(prev.value))
        }
        const yMin = valueToY(anchor) + devicePixelRatio
        const style = contentColor
        context.fillStyle = style
        context.strokeStyle = style
        context.beginPath()
        context.stroke(path)
        path.lineTo(xMax, yMin)
        path.lineTo(xMin, yMin)
        path.closePath()
        context.globalAlpha = alphaFill
        context.fill(path)
        context.globalAlpha = 1.00
    }
}