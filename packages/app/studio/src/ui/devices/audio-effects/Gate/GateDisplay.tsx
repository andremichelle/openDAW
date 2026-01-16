import css from "./GateDisplay.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {clamp, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {CanvasPainter} from "@/ui/canvas/painter"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "GateDisplay")

type Construct = {
    lifecycle: Lifecycle
    values: Float32Array  // [inputPeakDb, outputPeakDb, gateEnvelope, thresholdDb]
}

const DB_MIN = -60.0
const DB_MAX = 0.0
const HISTORY_SIZE = 256

const dbToY = (db: number, height: number): number => {
    const clampedDb = clamp(db, DB_MIN, DB_MAX)
    const normalized = (clampedDb - DB_MIN) / (DB_MAX - DB_MIN)
    return height * (1.0 - normalized)
}

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

                    inputHistory[writeIndex] = values[0]
                    outputHistory[writeIndex] = values[1]
                    envelopeHistory[writeIndex] = values[2]
                    writeIndex = (writeIndex + 1) % HISTORY_SIZE

                    context.clearRect(0, 0, actualWidth, actualHeight)

                    const lineWidth = 1.0 / devicePixelRatio

                    const inputPath = new Path2D()
                    const outputPath = new Path2D()
                    const envelopePath = new Path2D()

                    for (let i = 0; i < HISTORY_SIZE; i++) {
                        const bufferIndex = (writeIndex + i) % HISTORY_SIZE
                        const x = (i / HISTORY_SIZE) * actualWidth

                        const inputY = dbToY(inputHistory[bufferIndex], actualHeight)
                        const outputY = dbToY(outputHistory[bufferIndex], actualHeight)
                        const envelopeY = (1.0 - envelopeHistory[bufferIndex]) * actualHeight

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

                    const inputGradient = context.createLinearGradient(0, 0, 0, actualHeight)
                    inputGradient.addColorStop(0, DisplayPaint.strokeStyle(0.3))
                    inputGradient.addColorStop(1, DisplayPaint.strokeStyle(0.0))
                    context.fillStyle = inputGradient
                    context.fill(inputPath)

                    context.strokeStyle = DisplayPaint.strokeStyle(1.0)
                    context.lineWidth = lineWidth
                    context.stroke(outputPath)

                    outputPath.lineTo(actualWidth, actualHeight)
                    outputPath.lineTo(0, actualHeight)

                    const outputGradient = context.createLinearGradient(0, 0, 0, actualHeight)
                    outputGradient.addColorStop(0, DisplayPaint.strokeStyle(0.3))
                    outputGradient.addColorStop(1, DisplayPaint.strokeStyle(0.0))
                    context.fillStyle = outputGradient
                    context.fill(outputPath)

                    context.strokeStyle = Colors.orange.toString()
                    context.lineWidth = lineWidth
                    context.stroke(envelopePath)
                }))
                painter.requestUpdate()
                lifecycle.own(AnimationFrame.add(painter.requestUpdate))
            }}/>
        </div>
    )
}
