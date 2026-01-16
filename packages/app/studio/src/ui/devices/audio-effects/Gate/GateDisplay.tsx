import css from "./GateDisplay.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {clamp, Lifecycle, unitValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {CanvasPainter} from "@/ui/canvas/painter"

const className = Html.adoptStyleSheet(css, "GateDisplay")

type Construct = {
    lifecycle: Lifecycle
    values: Float32Array  // [inputPeakDb, outputPeakDb, gateEnvelope, thresholdDb]
}

const DB_MIN = -60.0
const DB_MAX = 0.0
const HISTORY_SIZE = 192

export const GateDisplay = ({lifecycle, values}: Construct) => {
    const inputHistory = new Float32Array(HISTORY_SIZE).fill(DB_MIN)
    const outputHistory = new Float32Array(HISTORY_SIZE).fill(DB_MIN)
    const envelopeHistory = new Float32Array(HISTORY_SIZE).fill(0.0)
    let writeIndex = 0

    return (
        <div classList={className}>
            <canvas onInit={canvas => {
                const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualWidth, actualHeight} = painter
                    context.clearRect(0, 0, actualWidth, actualHeight)

                    const lineWidth = 1.0 / devicePixelRatio
                    const bottom = actualHeight - lineWidth
                    const normToY = (normalized: unitValue) =>
                        bottom - (bottom - lineWidth) * normalized
                    const dbToY = (db: number): number =>
                        normToY((clamp(db, DB_MIN, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN))

                    inputHistory[writeIndex] = values[0]
                    outputHistory[writeIndex] = values[1]
                    envelopeHistory[writeIndex] = values[2]
                    writeIndex = (writeIndex + 1) % HISTORY_SIZE

                    const inputPath = new Path2D()
                    const outputPath = new Path2D()
                    const envelopePath = new Path2D()

                    for (let i = 0; i < HISTORY_SIZE; i++) {
                        const bufferIndex = (writeIndex + i) % HISTORY_SIZE
                        const x = Math.round((i / (HISTORY_SIZE - 1)) * actualWidth)
                        const inputY = dbToY(inputHistory[bufferIndex])
                        const outputY = dbToY(outputHistory[bufferIndex])
                        const envelopeY = normToY(envelopeHistory[bufferIndex])
                        if (i === 0) {
                            inputPath.moveTo(x, inputY)
                            outputPath.moveTo(x, outputY)
                            envelopePath.moveTo(x, envelopeY)
                        } else {
                            inputPath.lineTo(x, inputY)
                            outputPath.lineTo(x, outputY)
                            envelopePath.lineTo(x, envelopeY)
                        }
                    }
                    context.strokeStyle = DisplayPaint.strokeStyle(0.4)
                    context.lineWidth = lineWidth
                    context.stroke(inputPath)
                    inputPath.lineTo(actualWidth, actualHeight)
                    inputPath.lineTo(0, actualHeight)
                    const gradient = context.createLinearGradient(0, 0, 0, actualHeight)
                    gradient.addColorStop(0, DisplayPaint.strokeStyle(0.3))
                    gradient.addColorStop(1, "transparent")
                    context.fillStyle = gradient
                    context.fill(inputPath)
                    context.strokeStyle = DisplayPaint.strokeStyle(1.0)
                    context.lineWidth = lineWidth
                    context.stroke(outputPath)
                    outputPath.lineTo(actualWidth, actualHeight)
                    outputPath.lineTo(0, actualHeight)
                    context.fillStyle = gradient
                    context.fill(outputPath)

                    const envelopeGradient = context.createLinearGradient(0, 0, 0, actualHeight * 2)
                    envelopeGradient.addColorStop(0, "white")
                    envelopeGradient.addColorStop(1, "transparent")
                    context.strokeStyle = envelopeGradient
                    context.lineWidth = lineWidth
                    context.stroke(envelopePath)
                }))
                painter.requestUpdate()
                lifecycle.own(AnimationFrame.add(painter.requestUpdate))
            }}/>
        </div>
    )
}
