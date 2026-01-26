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
    const {inSlope: fadeInSlope, outSlope: fadeOutSlope} = fading
    const duration = endPPQN - startPPQN
    const totalFading = fading.in + fading.out
    const scale = totalFading > duration ? duration / totalFading : 1.0
    const fadeIn = fading.in * scale
    const fadeOut = fading.out * scale
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
        Curve.run(fadeInSlope, xn, top + height, top, y => context.lineTo(++x, y))
        context.lineTo(x1, top)
        context.closePath()
        context.fill()
    }
    if (fadeOut > 0) {
        const x0 = range.unitToX(endPPQN - fadeOut) * dpr
        const x1 = range.unitToX(endPPQN) * dpr
        const xn = x1 - x0
        context.beginPath()
        context.moveTo(x0, top)
        let x = x0
        Curve.run(fadeOutSlope, xn, top, top + height, y => context.lineTo(++x, y))
        context.lineTo(x1, top)
        context.closePath()
        context.fill()
    }
    const x0 = Math.max(range.unitToX(startPPQN + fadeIn), range.unitToX(startPPQN)) * dpr
    const x1 = Math.min(range.unitToX(endPPQN - fadeOut), range.unitToX(endPPQN)) * dpr
    context.fillStyle = handleColor
    context.beginPath()
    context.arc(x0, top, handleRadius, 0, TAU)
    context.fill()
    context.beginPath()
    context.arc(x1, top, handleRadius, 0, TAU)
    context.fill()
}