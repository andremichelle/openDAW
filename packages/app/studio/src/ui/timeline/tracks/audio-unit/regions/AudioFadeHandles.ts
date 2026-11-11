import {FadingEnvelope} from "@opendaw/lib-dsp"
import {clamp, Curve, Option, TAU} from "@opendaw/lib-std"
import {TimelineRange} from "@opendaw/studio-core"
import {RegionLabel} from "@/ui/timeline/RegionLabel"
import {AudioFadeAnchors} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeAnchors.ts"

export namespace AudioFadeHandles {
    export type LengthPart = "fading-in" | "fading-out"
    export type SlopePart = "fading-in-slope" | "fading-out-slope"
    export type Part = LengthPart | SlopePart
    export type Handle<PART extends Part> = {readonly part: PART, readonly x: number, readonly y: number}
    type Range = Pick<TimelineRange, "unitToX">

    export const radius = 4
    export const slopeRadius = 3
    export const hitRadius = 8
    export const SlopeOnCenterAxis = true
    const MinSlope = 0.001
    const MaxSlope = 0.999
    const SlopeSearchSteps = 28
    export const y = (): number => RegionLabel.labelHeight() + radius

    export const scale = (fading: FadingEnvelope.Config, duration: number): number =>
        fading.in + fading.out > duration ? duration / (fading.in + fading.out) : 1

    export const positions = (range: Range, fading: FadingEnvelope.Config, start: number, end: number) => {
        const fadeScale = scale(fading, Math.max(0, end - start))
        const left = range.unitToX(start), right = range.unitToX(end)
        const inset = Math.min(radius + 1, Math.max(0, (right - left) / 2))
        return {
            inX: clamp(range.unitToX(start + fading.in * fadeScale), left + inset, right - inset),
            outX: clamp(range.unitToX(end - fading.out * fadeScale), left + inset, right - inset)
        }
    }

    export const slopeHandles = (range: Range, fading: FadingEnvelope.Config, start: number, end: number,
                                 height: number, stored: AudioFadeAnchors = AudioFadeAnchors.Default)
        : ReadonlyArray<Handle<SlopePart>> => {
        const fadeScale = scale(fading, Math.max(0, end - start))
        const top = RegionLabel.labelHeight() + 1
        const anchors = SlopeOnCenterAxis ? AudioFadeAnchors.Default : stored
        const handles: Array<Handle<SlopePart>> = []
        if (fading.in > 0) {
            handles.push({part: "fading-in-slope", x: range.unitToX(start + fading.in * fadeScale * anchors.in),
                y: height + Curve.normalizedAt(anchors.in, fading.inSlope) * (top - height)})
        }
        if (fading.out > 0) {
            handles.push({part: "fading-out-slope", x: range.unitToX(end - fading.out * fadeScale * (1 - anchors.out)),
                y: top + Curve.normalizedAt(anchors.out, fading.outSlope) * (height - top)})
        }
        return handles
    }

    const lengthHandles = (range: Range, fading: FadingEnvelope.Config, start: number, end: number)
        : ReadonlyArray<Handle<LengthPart>> => {
        const {inX, outX} = positions(range, fading, start, end)
        return [{part: "fading-in", x: inX, y: y()}, {part: "fading-out", x: outX, y: y()}]
    }

    export const hitTest = (range: Range, fading: FadingEnvelope.Config, start: number, end: number, height: number,
                            anchors: AudioFadeAnchors, x: number, localY: number): Option<Part> => {
        if (x < range.unitToX(start) || x >= range.unitToX(end)) {return Option.None}
        const circles = slopeHandles(range, fading, start, end, height, anchors)
        const squares = lengthHandles(range, fading, start, end)
        let closest: Option<Part> = Option.None
        let bestDistance = hitRadius ** 2
        let bestOnShape = false
        for (const [handles, circle] of [[circles.toReversed(), true], [squares, false]] as const) {
            for (const handle of handles) {
                const dx = Math.abs(x - handle.x), dy = Math.abs(localY - handle.y)
                const distance = dx * dx + dy * dy
                const onShape = circle ? Math.hypot(dx, dy) <= slopeRadius : Math.max(dx, dy) <= radius
                if (distance > hitRadius ** 2) {continue}
                if ((onShape && !bestOnShape) || (onShape === bestOnShape && distance < bestDistance)) {
                    bestDistance = distance
                    bestOnShape = onShape
                    closest = Option.wrap(handle.part)
                }
            }
        }
        return closest
    }

    export const curveAfterDrag = (originalSlope: number, storedPosition: number,
                                   deltaX: number, deltaY: number, width: number, height: number, fadeIn: boolean) => {
        const originalPosition = SlopeOnCenterAxis ? AudioFadeAnchors.Default.in : storedPosition
        const shiftX = SlopeOnCenterAxis ? 0 : deltaX
        const target = clamp(Curve.normalizedAt(originalPosition, originalSlope)
            + (fadeIn ? -deltaY : deltaY) / Math.max(1, height - RegionLabel.labelHeight() - 1), 0, 1)
        const earliest = clamp(Curve.inverseAt(target, MaxSlope), AudioFadeAnchors.Min, AudioFadeAnchors.Max)
        const latest = clamp(Curve.inverseAt(target, MinSlope), earliest, AudioFadeAnchors.Max)
        const position = clamp(originalPosition + shiftX / Math.max(1, width), earliest, latest)
        let low = MinSlope, high = MaxSlope
        for (let step = 0; step < SlopeSearchSteps; step++) {
            const middle = (low + high) / 2
            if (Curve.normalizedAt(position, middle) < target) {low = middle} else {high = middle}
        }
        return {position, slope: (low + high) / 2}
    }

    export const render = (context: CanvasRenderingContext2D, range: TimelineRange, fading: FadingEnvelope.Config,
                           start: number, end: number, height: number, color: string, anchors: AudioFadeAnchors): void => {
        const dpr = devicePixelRatio
        context.save()
        context.fillStyle = color
        for (const {x, y} of lengthHandles(range, fading, start, end)) {
            context.fillRect((x - radius) * dpr, (y - radius) * dpr, radius * 2 * dpr, radius * 2 * dpr)
        }
        for (const {x, y} of slopeHandles(range, fading, start, end, height, anchors)) {
            context.beginPath()
            context.arc(x * dpr, y * dpr, slopeRadius * dpr, 0, TAU)
            context.fill()
        }
        context.restore()
    }
}
