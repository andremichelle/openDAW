import {Curve, TAU} from "@opendaw/lib-std"
import {TimelineRange} from "@opendaw/studio-core"
import {FadingEnvelope} from "@opendaw/lib-dsp"
import {RegionBound} from "@/ui/timeline/renderer/env"

export const renderFading = (context: CanvasRenderingContext2D,
                             range: TimelineRange,
                             fading: FadingEnvelope.Config,
                             {top, bottom}: RegionBound,
                             startPPQN: number,
                             endPPQN: number,
                             color: string,
                             handleColor: string): void => {
    const {in: fadeIn, out: fadeOut, inSlope: fadeInSlope, outSlope: fadeOutSlope} = fading
    const dpr = devicePixelRatio
    const height = bottom - top
    const handleRadius = 3 * dpr
    context.fillStyle = color
    if (fadeIn > 0) {
        const fadeInEndPPQN = startPPQN + fadeIn
        const x0 = range.unitToX(startPPQN) * dpr
        const x1 = range.unitToX(fadeInEndPPQN) * dpr
        const xn = x1 - x0
        context.beginPath()
        context.moveTo(x0, top)
        let x = x0
        for (const y of Curve.walk(fadeInSlope, xn, top + height, top)) {
            context.lineTo(++x, y)
        }
        context.lineTo(x1, top)
        context.closePath()
        context.fill()
    }
    if (fadeOut > 0) {
        const x0 = range.unitToX(endPPQN - fadeOut) * dpr
        const x1 = range.unitToX(endPPQN) * dpr
        const xn = Math.abs(x1 - x0)
        context.beginPath()
        context.moveTo(x0, top)
        let x = x0
        for (const y of Curve.walk(fadeOutSlope, xn, top, top + height)) {
            context.lineTo(++x, y)
        }
        context.lineTo(x1, top)
        context.closePath()
        context.fill()
    }
    const fadeInHandleX = range.unitToX(startPPQN + fadeIn) * dpr
    const fadeOutHandleX = range.unitToX(endPPQN - fadeOut) * dpr
    const regionStartX = range.unitToX(startPPQN) * dpr
    const regionEndX = range.unitToX(endPPQN) * dpr
    const adjustedFadeInX = Math.max(fadeInHandleX, regionStartX)
    const adjustedFadeOutX = Math.min(fadeOutHandleX, regionEndX)
    if (adjustedFadeOutX - adjustedFadeInX > handleRadius * 4) {
        context.fillStyle = handleColor
        context.beginPath()
        context.arc(adjustedFadeInX, top, handleRadius, 0, TAU)
        context.fill()
        context.beginPath()
        context.arc(adjustedFadeOutX, top, handleRadius, 0, TAU)
        context.fill()
    }
}