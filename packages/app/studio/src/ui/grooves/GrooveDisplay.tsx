import css from "./GrooveDisplay.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {PPQN} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"
import {GrooveAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint.ts"

const className = Html.adoptStyleSheet(css, "GrooveDisplay")

type Construct = {
    lifecycle: Lifecycle
    groove: GrooveAdapter
}

// The curve over one cell, a stack shows one bar
export const GrooveDisplay = ({lifecycle, groove}: Construct): HTMLElement => {
    const curveCanvas: HTMLCanvasElement = <canvas/>
    const span = (): number => {
        const cell = groove.cellDuration()
        return cell > 0 ? cell : PPQN.Bar
    }
    const curvePainter = lifecycle.own(new CanvasPainter(curveCanvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        context.clearRect(0, 0, actualWidth, actualHeight)
        const padding = devicePixelRatio * 0.5 // half a line, so the outer grid lines sit on the edges
        const width = actualWidth - padding * 2
        const height = actualHeight - padding * 2
        const duration = span()
        const lines = Math.max(1, Math.min(16, Math.round(duration / PPQN.SemiQuaver)))
        context.lineWidth = devicePixelRatio
        context.strokeStyle = DisplayPaint.gridStyle()
        context.beginPath()
        for (let index = 0; index <= lines; index++) {
            const offset = index / lines
            context.moveTo(padding + offset * width, padding)
            context.lineTo(padding + offset * width, padding + height)
            context.moveTo(padding, padding + offset * height)
            context.lineTo(padding + width, padding + offset * height)
        }
        context.stroke()
        context.setLineDash([2 * devicePixelRatio, 2 * devicePixelRatio])
        context.strokeStyle = DisplayPaint.strokeStyle(0.25)
        context.beginPath()
        context.moveTo(padding, padding + height)
        context.lineTo(padding + width, padding)
        context.stroke()
        context.setLineDash([])
        const steps = Math.max(2, Math.round(width))
        const path = new Path2D()
        for (let index = 0; index <= steps; index++) {
            const x = index / steps
            const y = groove.warp(x * duration) / duration
            const px = padding + x * width
            const py = padding + (1.0 - y) * height
            if (index === 0) {path.moveTo(px, py)} else {path.lineTo(px, py)}
        }
        context.lineWidth = devicePixelRatio * 1.5
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.stroke(path)
    }))
    lifecycle.own(groove.subscribeChange(() => {
        curvePainter.requestUpdate()
    }))
    return (
        <header className={className}>
            <div className="curve">{curveCanvas}</div>
        </header>
    )
}
