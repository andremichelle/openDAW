import {Curve, TAU} from "@moises-ai/lib-std"
import {FadingEnvelope} from "@moises-ai/lib-dsp"
import {TimelineRange} from "../../index"
import {RegionBound} from "./env"

export namespace AudioFadingRenderer {
    export const render = (context: CanvasRenderingContext2D,
                           range: TimelineRange,
                           fading: FadingEnvelope.Config,
                           {top, bottom}: RegionBound,
                           startPPQN: number,
                           endPPQN: number,
                           color: string): void => {
        const dpr = devicePixelRatio
        const actualTop = top * dpr
        const actualBottom = bottom * dpr
        const {inSlope: fadeInSlope, outSlope: fadeOutSlope} = fading
        const duration = endPPQN - startPPQN
        const totalFading = fading.in + fading.out
        const scale = totalFading > duration ? duration / totalFading : 1.0
        const fadeIn = fading.in * scale
        const fadeOut = fading.out * scale
        context.strokeStyle = color
        context.fillStyle = "rgba(0,0,0,0.25)"
        context.lineWidth = dpr
        if (fadeIn > 0) {
            const fadeInEndPPQN = startPPQN + fadeIn
            const x0 = range.unitToX(startPPQN) * dpr
            const x1 = range.unitToX(fadeInEndPPQN) * dpr
            const xn = x1 - x0
            const path = new Path2D()
            path.moveTo(x0, actualBottom)
            let x = x0
            Curve.run(fadeInSlope, xn, actualBottom, actualTop, y => path.lineTo(++x, y))
            path.lineTo(x1, actualTop)
            context.stroke(path)
            path.lineTo(x0, actualTop)
            path.lineTo(x0, actualBottom)
            context.fill(path)
        }
        if (fadeOut > 0) {
            const x0 = range.unitToX(endPPQN - fadeOut) * dpr
            const x1 = range.unitToX(endPPQN) * dpr
            const xn = x1 - x0
            const path = new Path2D()
            path.moveTo(x0, actualTop)
            let x = x0
            Curve.run(fadeOutSlope, xn, actualTop, actualBottom, y => path.lineTo(++x, y))
            path.lineTo(x1, actualBottom)
            context.strokeStyle = color
            context.stroke(path)
            path.lineTo(x1, actualTop)
            path.lineTo(x0, actualTop)
            context.fill(path)
        }
        const handleRadius = 1.5 * dpr
        const x0 = Math.max(range.unitToX(startPPQN + fadeIn), range.unitToX(startPPQN)) * dpr
        const x1 = Math.min(range.unitToX(endPPQN - fadeOut), range.unitToX(endPPQN)) * dpr
        context.fillStyle = color
        context.beginPath()
        context.arc(x0, actualTop, handleRadius, 0, TAU)
        context.fill()
        context.beginPath()
        context.arc(x1, actualTop, handleRadius, 0, TAU)
        context.fill()
    }
}