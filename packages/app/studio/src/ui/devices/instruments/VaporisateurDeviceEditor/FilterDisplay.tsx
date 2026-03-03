import css from "./Display.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {int, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {AutomatableParameterFieldAdapter, VaporisateurSettings} from "@opendaw/studio-adapters"
import {BiquadCoeff, gainToDb} from "@opendaw/lib-dsp"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "Display")

type Construct = {
    lifecycle: Lifecycle
    cutoff: AutomatableParameterFieldAdapter<number>
    resonance: AutomatableParameterFieldAdapter<number>
    order: AutomatableParameterFieldAdapter<int>
}

export const FilterDisplay = ({lifecycle, cutoff, resonance, order}: Construct) => {
    const coeff = new BiquadCoeff()
    let frequency = new Float32Array(0)
    let magResponse = new Float32Array(0)
    let phaseResponse = new Float32Array(0)
    return (
        <canvas className={className} onInit={canvas => {
            const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                const {context, actualWidth, actualHeight, devicePixelRatio} = painter
                const oversampling = 4
                const invOversampling = 1.0 / oversampling
                const oversampledWidth = actualWidth * oversampling
                const padding = devicePixelRatio * 2
                const top = padding
                const bottom = actualHeight - padding
                const minDb = -24.0
                const maxDb = +24.0
                const o = order.getControlledValue()
                const gainToY = (value: number) => bottom + (top - bottom) * (gainToDb(value) * o - minDb) / (maxDb - minDb)
                const sf = 48000
                coeff.setLowpassParams(cutoff.getControlledValue() / sf, resonance.getControlledValue() / (o ** 1.25))
                if (frequency.length !== oversampledWidth) {
                    frequency = new Float32Array(oversampledWidth)
                    magResponse = new Float32Array(oversampledWidth)
                    phaseResponse = new Float32Array(oversampledWidth)
                }
                for (let x = 0; x < oversampledWidth; x++) {
                    const freq = VaporisateurSettings.CUTOFF_VALUE_MAPPING.y(x / oversampledWidth)
                    frequency[x] = freq / sf
                }
                coeff.getFrequencyResponse(frequency, magResponse, phaseResponse)
                context.lineWidth = devicePixelRatio
                const path = new Path2D()
                path.moveTo(0, gainToY(magResponse[0]))
                for (let x = 1; x < oversampledWidth; x++) {
                    const y = gainToY(magResponse[x])
                    if (y >= bottom) {break}
                    path.lineTo(x * invOversampling, y)
                }
                context.strokeStyle = DisplayPaint.strokeStyle(0.75)
                context.stroke(path)
                path.lineTo(actualWidth, bottom)
                path.lineTo(0, bottom)
                const gradient = context.createLinearGradient(0, top, 0, bottom)
                gradient.addColorStop(0.5, DisplayPaint.strokeStyle(0.2))
                gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.0))
                context.fillStyle = gradient
                context.fill(path)
                context.beginPath()
                context.setLineDash([2, 2])
                const zeroDbY = gainToY(1.0)
                context.moveTo(0, zeroDbY)
                context.lineTo(actualWidth, zeroDbY)
                context.strokeStyle = DisplayPaint.strokeStyle(0.25)
                context.stroke()
            }))
            lifecycle.ownAll(
                cutoff.catchupAndSubscribe(painter.requestUpdate),
                resonance.catchupAndSubscribe(painter.requestUpdate),
                order.catchupAndSubscribe(painter.requestUpdate)
            )
        }}/>
    )
}