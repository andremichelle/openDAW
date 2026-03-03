import css from "./Display.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Func, Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "Display")

type Construct = {
    lifecycle: Lifecycle
    adapter: ObservableValue<Func<number, number>>
}

export const WaveformDisplay = ({lifecycle, adapter}: Construct) => {
    return (
        <canvas className={className} onInit={canvas => {
            const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                const {context, actualWidth, actualHeight, devicePixelRatio} = painter
                const padding = devicePixelRatio * 2
                const top = padding
                const bottom = actualHeight - padding
                const valueToY = (value: number) => bottom + (top - bottom) * (0.5 * (value + 1.0))
                const centerY = valueToY(0.0)
                const fx = adapter.getValue()
                context.lineWidth = devicePixelRatio
                const path = new Path2D()
                path.moveTo(0, valueToY(fx(0)))
                for (let x = 1; x <= actualWidth; x++) {
                    path.lineTo(x, valueToY(fx(x / actualWidth)))
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
            lifecycle.own(adapter.catchupAndSubscribe(painter.requestUpdate))
        }}/>
    )
}