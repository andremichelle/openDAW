import css from "./Display.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {Address} from "@opendaw/lib-box"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "Display")

type Construct = {
    lifecycle: Lifecycle
    sustain: AutomatableParameterFieldAdapter<number>
    receiver: LiveStreamReceiver
    address: Address
}

export const EnvelopeDisplay = ({lifecycle, sustain, receiver, address}: Construct) => {
    const envValues = new Float32Array(32).fill(-1)
    return (
        <canvas className={className} onInit={canvas => {
            const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                const {context, actualWidth, actualHeight, devicePixelRatio} = painter
                const padding = devicePixelRatio * 2
                const top = padding
                const bottom = actualHeight - padding
                const valueToY = (value: number) => bottom + (top - bottom) * value
                const adsr = (x: number, s: number): number => {
                    if (x < 0.25) {return x * 4.0}
                    if (x < 0.5) {return 1.0 - (x - 0.25) * 4.0 * (1.0 - s)}
                    if (x < 0.75) {return s}
                    return s * (1.0 - (x - 0.75) * 4.0)
                }
                const s = sustain.getControlledValue()
                context.lineWidth = devicePixelRatio
                const path = new Path2D()
                path.moveTo(0, valueToY(adsr(0, s)))
                for (let x = 1; x <= actualWidth; x++) {
                    path.lineTo(x, valueToY(adsr(x / actualWidth, s)))
                }
                context.strokeStyle = DisplayPaint.strokeStyle(0.75)
                context.stroke(path)
                path.lineTo(actualWidth, valueToY(0.0))
                path.lineTo(0, valueToY(0.0))
                const gradient = context.createLinearGradient(0, top, 0, bottom)
                gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.2))
                gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.0))
                context.fillStyle = gradient
                context.fill(path)
                context.beginPath()
                context.moveTo(actualWidth / 4, top)
                context.lineTo(actualWidth / 4, bottom)
                context.moveTo(actualWidth / 2, top)
                context.lineTo(actualWidth / 2, bottom)
                context.moveTo(actualWidth / 4 * 3, top)
                context.lineTo(actualWidth / 4 * 3, bottom)
                context.setLineDash([2, 2])
                context.strokeStyle = DisplayPaint.strokeStyle(0.2)
                context.stroke()

                for (let i = 0; i < envValues.length; i++) {
                    const envValue = envValues[i]
                    if (envValue === -1) {break}
                    context.beginPath()
                    context.arc(envValue * actualWidth, valueToY(adsr(envValue, s)), devicePixelRatio, 0.0, TAU)
                    context.fillStyle = "hsl(200, 83%, 75%)"
                    context.fill()
                }
            }))
            lifecycle.ownAll(
                receiver.subscribeFloats(address, (phases) => {
                    for (let i = 0; i < phases.length; i++) {
                        const phase = phases[i]
                        if (phase === -1) {
                            envValues[i] = -1
                            break
                        }
                        envValues[i] = phase * 0.25
                    }
                    painter.requestUpdate()
                }),
                sustain.catchupAndSubscribe(painter.requestUpdate)
            )
        }}/>
    )
}