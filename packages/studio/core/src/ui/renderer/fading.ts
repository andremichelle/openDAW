import {Curve, TAU} from "@opendaw/lib-std"
import {FadingEnvelope} from "@opendaw/lib-dsp"
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
        const {inSlope: fadeInSlope, outSlope: fadeOutSlope} = fading
        const duration = endPPQN - startPPQN
        const totalFading = fading.in + fading.out
        const scale = totalFading > duration ? duration / totalFading : 1.0
        const fadeIn = fading.in * scale
        const fadeOut = fading.out * scale
        context.strokeStyle = color
        context.fillStyle = "rgba(0,0,0,0.25)"
        context.lineWidth = devicePixelRatio
        if (fadeIn > 0) {
            const fadeInEndPPQN = startPPQN + fadeIn
            const x0 = range.unitToX(startPPQN) * devicePixelRatio
            const x1 = range.unitToX(fadeInEndPPQN) * devicePixelRatio
            const xn = x1 - x0
            const path = new Path2D()
            path.moveTo(x0, bottom)
            let x = x0
            Curve.run(fadeInSlope, xn, bottom, top, y => path.lineTo(++x, y))
            path.lineTo(x1, top)
            context.stroke(path)
            path.lineTo(x0, top)
            path.lineTo(x0, bottom)
            context.fill(path)
        }
        if (fadeOut > 0) {
            const x0 = range.unitToX(endPPQN - fadeOut) * devicePixelRatio
            const x1 = range.unitToX(endPPQN) * devicePixelRatio
            const xn = x1 - x0
            const path = new Path2D()
            path.moveTo(x0, top)
            let x = x0
            Curve.run(fadeOutSlope, xn, top, bottom, y => path.lineTo(++x, y))
            path.lineTo(x1, bottom)
            context.strokeStyle = color
            context.stroke(path)
            path.lineTo(x1, top)
            path.lineTo(x0, top)
            context.fill(path)
        }
        const handleRadius = 1.5 * devicePixelRatio
        const x0 = Math.max(range.unitToX(startPPQN + fadeIn), range.unitToX(startPPQN)) * devicePixelRatio
        const x1 = Math.min(range.unitToX(endPPQN - fadeOut), range.unitToX(endPPQN)) * devicePixelRatio
        context.fillStyle = color
        context.beginPath()
        context.arc(x0, top, handleRadius, 0, TAU)
        context.fill()
        context.beginPath()
        context.arc(x1, top, handleRadius, 0, TAU)
        context.fill()
    }
}