import css from "./ShapeDisplay.sass?inline"
import {Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {CanvasPainter} from "@opendaw/studio-core"
import {DisplayPaint} from "@/ui/devices/DisplayPaint.ts"
import {LfoModulatorBoxAdapter, LfoShape} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "ShapeDisplay")

type Construct = {
    lifecycle: Lifecycle
    modulator: LfoModulatorBoxAdapter
}

// WASM CONTRACT: mirrors the engine's `modulation.rs` shapes.
const shapeAt = (shape: LfoShape, turn: number): number => {
    const phase = turn - Math.floor(turn)
    switch (shape) {
        case LfoShape.Triangle:
            return phase < 0.25 ? phase * 4.0 : phase < 0.75 ? 2.0 - phase * 4.0 : phase * 4.0 - 4.0
        case LfoShape.Saw:
            return phase * 2.0 - 1.0
        case LfoShape.Square:
            return phase < 0.5 ? 1.0 : -1.0
        default:
            return Math.sin(TAU * phase)
    }
}

export const ShapeDisplay = ({lifecycle, modulator}: Construct): HTMLElement => {
    const canvas: HTMLCanvasElement = (<canvas/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        context.clearRect(0, 0, actualWidth, actualHeight)
        const shape: LfoShape = modulator.box.shape.getValue()
        const phase = modulator.box.phase.getValue()
        const amount = modulator.box.amount.getValue()
        const padding = devicePixelRatio * 2
        const top = padding
        const bottom = actualHeight - padding
        const valueToY = (value: number) => bottom + (top - bottom) * (0.5 * (value * amount + 1.0))
        const centerY = valueToY(0.0)
        context.lineWidth = devicePixelRatio
        const path = new Path2D()
        path.moveTo(0, valueToY(shapeAt(shape, phase)))
        for (let x = 1; x <= actualWidth; x++) {
            path.lineTo(x, valueToY(shapeAt(shape, x / actualWidth + phase)))
        }
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.stroke(path)
        path.lineTo(actualWidth, centerY)
        path.lineTo(0, centerY)
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.2))
        gradient.addColorStop(0.5, DisplayPaint.strokeStyle(0.0))
        gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.2))
        context.fillStyle = gradient
        context.fill(path)
        context.beginPath()
        context.moveTo(0, centerY)
        context.lineTo(actualWidth, centerY)
        context.strokeStyle = "hsla(200, 83%, 60%, 0.25)"
        context.stroke()
    }))
    lifecycle.ownAll(
        modulator.box.shape.subscribe(painter.requestUpdate),
        modulator.box.phase.subscribe(painter.requestUpdate),
        modulator.box.amount.subscribe(painter.requestUpdate)
    )
    return <div className={className}>{canvas}</div>
}
