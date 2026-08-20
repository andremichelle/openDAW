import css from "./StepsDisplay.sass?inline"
import {clamp, int, Lifecycle, TAU} from "@opendaw/lib-std"
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
        const bipolar = modulator.box.bipolar.getValue()
        const baseY = bipolar ? (top + bottom) / 2 : bottom
        const emitted = (value: number) => bipolar ? value : value * 0.5 + 0.5
        const valueToY = (value: number) =>
            baseY - emitted(value) * (bottom - top) / (bipolar ? 2 : 1)
        const outputToY = (value: number) => baseY - value * (bottom - top) / (bipolar ? 2 : 1)
        const stepWidth = actualWidth / count
        const gap = Math.min(devicePixelRatio, stepWidth * 0.1)
        context.fillStyle = DisplayPaint.baselineGradient(context, top, bottom, bipolar)
        for (let index = 0; index < count; index++) {
            const value = modulator.draw(page + index)
            const x = index * stepWidth
            const y = valueToY(value)
            context.fillRect(x + gap, Math.min(y, baseY), stepWidth - gap * 2, Math.max(1, Math.abs(y - baseY)))
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
        context.moveTo(0, baseY)
        context.lineTo(actualWidth, baseY)
        context.strokeStyle = "hsl(200, 83%, 60%, 0.1)"
        context.stroke()
        context.beginPath()
        context.arc((playhead - page) * stepWidth, outputToY(output), devicePixelRatio * 2.0, 0.0, TAU)
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
