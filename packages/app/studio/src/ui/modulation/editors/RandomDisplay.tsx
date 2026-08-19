import css from "./StepsDisplay.sass?inline"
import {clamp, int, Lifecycle, TAU, unitValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Propagation} from "@opendaw/lib-box"
import {CanvasPainter} from "@opendaw/studio-core"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {RandomModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint.ts"

const className = Html.adoptStyleSheet(css, "StepsDisplay")

const PageSteps = 16

type Construct = {
    lifecycle: Lifecycle
    receiver: LiveStreamReceiver
    modulator: RandomModulatorBoxAdapter
}

export const RandomDisplay = ({lifecycle, receiver, modulator}: Construct): HTMLElement => {
    const canvas: HTMLCanvasElement = (<canvas/>)
    let playhead = 0.0
    let output = 0.0
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        context.clearRect(0, 0, actualWidth, actualHeight)
        const loop = clamp(modulator.loop, 0, RandomModulatorBoxAdapter.MaxLoop)
        const count: int = loop > 0 ? loop : PageSteps
        const page = Math.floor(playhead / count) * count
        const padding = devicePixelRatio * 2
        const top = padding
        const bottom = actualHeight - padding
        const centerY = (top + bottom) / 2
        const valueToY = (value: unitValue) => centerY - value * (bottom - top) / 2
        const stepWidth = actualWidth / count
        const gap = Math.min(devicePixelRatio, stepWidth * 0.1)
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.2))
        gradient.addColorStop(0.5, DisplayPaint.strokeStyle(0.0))
        gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.2))
        context.fillStyle = gradient
        for (let index = 0; index < count; index++) {
            const value = modulator.draw(page + index)
            const x = index * stepWidth
            const y = valueToY(value)
            context.fillRect(x + gap, Math.min(y, centerY), stepWidth - gap * 2, Math.max(1, Math.abs(y - centerY)))
        }
        context.lineWidth = devicePixelRatio
        context.strokeStyle = DisplayPaint.strokeStyle(1.0)
        context.beginPath()
        for (let index = 0; index < count; index++) {
            const y = valueToY(modulator.draw(page + index))
            context.moveTo(index * stepWidth + gap, y)
            context.lineTo((index + 1) * stepWidth - gap, y)
        }
        context.stroke()
        context.beginPath()
        for (let x = 0; x <= actualWidth; x++) {
            const y = valueToY(modulator.valueAt(page + Math.min(x, actualWidth - 0.5) / stepWidth))
            if (x === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
        }
        context.strokeStyle = "rgba(255, 255, 255, 0.3)"
        context.stroke()
        context.beginPath()
        context.moveTo(0, centerY)
        context.lineTo(actualWidth, centerY)
        context.strokeStyle = "hsl(200, 83%, 60%, 0.1)"
        context.stroke()
        context.beginPath()
        context.arc((playhead - page) * stepWidth, valueToY(output), devicePixelRatio * 2.0, 0.0, TAU)
        context.fillStyle = "hsl(200, 83%, 75%)"
        context.fill()
    }))
    lifecycle.ownAll(
        modulator.box.subscribe(Propagation.Children, painter.requestUpdate),
        receiver.subscribeFloats(modulator.address, ([position, value]) => {
            playhead = position
            output = value
            painter.requestUpdate()
        })
    )
    return <div className={className}>{canvas}</div>
}
