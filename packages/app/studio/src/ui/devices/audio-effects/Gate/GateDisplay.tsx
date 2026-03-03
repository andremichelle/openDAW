import css from "./GateDisplay.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Lifecycle, unitValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {GateDeviceBoxAdapter} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "GateDisplay")

type Construct = {
    lifecycle: Lifecycle
    adapter: GateDeviceBoxAdapter
    values: Float32Array  // [inputPeakDb, outputPeakDb, gateEnvelope, thresholdDb]
}

const DB_MIN = -66.0
const DB_MAX = 6.0
const HISTORY_SIZE = 128 + 1

export const GateDisplay = ({lifecycle, adapter, values}: Construct) => {
    const inputHistory = new Float32Array(HISTORY_SIZE).fill(Number.MAX_VALUE)
    const outputHistory = new Float32Array(HISTORY_SIZE).fill(Number.MAX_VALUE)
    const envelopeHistory = new Float32Array(HISTORY_SIZE).fill(Number.MAX_VALUE)
    let writeIndex = 0
    return (
        <div classList={className}>
            <canvas onInit={canvas => {
                const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualWidth, actualHeight, devicePixelRatio} = painter
                    context.clearRect(0, 0, actualWidth, actualHeight)

                    const lineWidth = 2.0 / devicePixelRatio
                    const normToY = (normalized: unitValue) => {
                        return normalized === Number.NEGATIVE_INFINITY
                            ? actualHeight + devicePixelRatio
                            : actualHeight - actualHeight * normalized
                    }
                    const dbToY = (db: number): number => normToY(((db - DB_MIN) / (DB_MAX - DB_MIN)))

                    inputHistory[writeIndex] = dbToY(values[0])
                    outputHistory[writeIndex] = dbToY(values[1])
                    envelopeHistory[writeIndex] = dbToY(values[2])
                    writeIndex = (writeIndex + 1) % HISTORY_SIZE

                    const inputPath = new Path2D()
                    const outputPath = new Path2D()
                    const envelopePath = new Path2D()

                    for (let i = 0; i < HISTORY_SIZE; i++) {
                        const bufferIndex = (writeIndex + i) % HISTORY_SIZE
                        const x = (i / (HISTORY_SIZE - 1) * actualWidth)
                        const inputY = inputHistory[bufferIndex]
                        const outputY = outputHistory[bufferIndex]
                        const envelopeY = envelopeHistory[bufferIndex]
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

                    const threshold = adapter.namedParameter.threshold.getControlledValue()
                    const returnValue = adapter.namedParameter.return.getControlledValue()
                    const thresholdY = dbToY(threshold)
                    const returnY = dbToY(threshold - returnValue)

                    context.strokeStyle = DisplayPaint.strokeStyle(0.5)
                    context.lineWidth = lineWidth
                    context.beginPath()
                    context.moveTo(0, thresholdY)
                    context.lineTo(actualWidth, thresholdY)
                    context.moveTo(0, returnY)
                    context.lineTo(actualWidth, returnY)
                    context.stroke()
                    context.fillStyle = DisplayPaint.strokeStyle(0.03)
                    context.fillRect(0, thresholdY, actualWidth, returnY - thresholdY)
                }))
                painter.requestUpdate()
                lifecycle.own(AnimationFrame.add(painter.requestUpdate))
            }}/>
            <svg>
                {[0, 12, 24, 36, 48, 60].map(db => {
                    const normalized = (-db - DB_MIN) / (DB_MAX - DB_MIN)
                    return <text x="2"
                                 y={`${((1.0 - normalized) * 100)}%`}
                                 font-size="8" fill="rgba(255, 255, 255, 0.2)"
                                 dominant-baseline="middle">{db}</text>
                })}
            </svg>
        </div>
    )
}
