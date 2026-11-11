import type {FadingEnvelope} from "@opendaw/lib-dsp"
import {clamp, Curve} from "@opendaw/lib-std"
import type {TimelineRange} from "@opendaw/studio-core"
import {RegionLabel} from "@/ui/timeline/RegionLabel"

export namespace AudioFadeHandles {
    export const radius = 4
    export const hitRadius = 8
    export const y = (): number => RegionLabel.labelHeight() + radius + 1

    export const positions = (range: Pick<TimelineRange, "unitToX">,
                              fading: FadingEnvelope.Config, start: number, end: number) => {
        const duration = Math.max(0, end - start)
        const scale = fading.in + fading.out > duration ? duration / (fading.in + fading.out) : 1
        const left = range.unitToX(start), right = range.unitToX(end)
        const inset = Math.min(radius + 1, Math.max(0, (right - left) / 2))
        return {
            inX: clamp(range.unitToX(start + fading.in * scale), left + inset, right - inset),
            outX: clamp(range.unitToX(end - fading.out * scale), left + inset, right - inset)
        }
    }

    export const slopeHandles = (range: Pick<TimelineRange, "unitToX">,
                                 fading: FadingEnvelope.Config, start: number, end: number, height: number,
                                 anchors = {in: 0.5, out: 0.5}) => {
        const duration = Math.max(0, end - start)
        const scale = fading.in + fading.out > duration ? duration / (fading.in + fading.out) : 1
        const top = RegionLabel.labelHeight() + 1
        const bottom = height
        return [
            ...(fading.in > 0 ? [{part: "fading-in-slope" as const,
                x: range.unitToX(start + fading.in * scale * anchors.in),
                y: bottom + Curve.normalizedAt(anchors.in, fading.inSlope) * (top - bottom)}] : []),
            ...(fading.out > 0 ? [{part: "fading-out-slope" as const,
                x: range.unitToX(end - fading.out * scale * (1 - anchors.out)),
                y: top + Curve.normalizedAt(anchors.out, fading.outSlope) * (bottom - top)}] : [])
        ]
    }

    export const curveAfterDrag = (originalSlope: number, originalPosition: number,
                                   deltaX: number, deltaY: number, width: number, height: number, fadeIn: boolean) => {
        const position = clamp(originalPosition + deltaX / Math.max(1, width), 0.02, 0.98)
        const target = clamp(Curve.normalizedAt(originalPosition, originalSlope)
            + (fadeIn ? -deltaY : deltaY) / Math.max(1, height - RegionLabel.labelHeight() - 1), 0, 1)
        // Fit the existing audible curve through the dragged point, rather than adding X to a Y-only delta.
        let low = 0.001, high = 0.999
        for (let i = 0; i < 28; i++) {
            const middle = (low + high) / 2
            if (Curve.normalizedAt(position, middle) < target) {low = middle} else {high = middle}
        }
        return {position, slope: (low + high) / 2}
    }

    export const render = (context: CanvasRenderingContext2D, range: TimelineRange,
                           fading: FadingEnvelope.Config, start: number, end: number, color: string,
                           anchors = {in: 0.5, out: 0.5}): void => {
        const {inX, outX} = positions(range, fading, start, end)
        const dpr = devicePixelRatio
        context.save()
        context.fillStyle = color
        context.strokeStyle = "#15191d"
        context.lineWidth = 1.5 * dpr
        for (const x of [inX, outX]) {
            context.beginPath()
            context.rect((x - radius) * dpr, (y() - radius) * dpr, radius * 2 * dpr, radius * 2 * dpr)
            context.fill()
            context.stroke()
        }
        for (const {x, y} of slopeHandles(range, fading, start, end, context.canvas.clientHeight, anchors)) {
            context.beginPath()
            context.moveTo(x * dpr, (y - radius) * dpr)
            context.lineTo((x + radius) * dpr, y * dpr)
            context.lineTo(x * dpr, (y + radius) * dpr)
            context.lineTo((x - radius) * dpr, y * dpr)
            context.closePath()
            context.fill()
            context.stroke()
        }
        context.restore()
    }
}
