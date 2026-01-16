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
const HISTORY_SIZE = 216

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
                    context.fillStyle = DisplayPaint.strokeStyle(0.2)
                    for (let i = 0; i < HISTORY_SIZE; i++) {
                        const bufferIndex = (writeIndex + i) % HISTORY_SIZE
                        const x = (i / HISTORY_SIZE) * actualWidth
                        const y = dbToY(inputHistory[bufferIndex], actualHeight)
                        context.fillRect(x, y, actualWidth / HISTORY_SIZE + 1, actualHeight - y)
                    }
                    context.fillStyle = DisplayPaint.strokeStyle(0.6)
                    for (let i = 0; i < HISTORY_SIZE; i++) {
                        const bufferIndex = (writeIndex + i) % HISTORY_SIZE
                        const x = (i / HISTORY_SIZE) * actualWidth
                        const y = dbToY(outputHistory[bufferIndex], actualHeight)
                        context.fillRect(x, y, actualWidth / HISTORY_SIZE + 1, actualHeight - y)
                    }
                    context.strokeStyle = Colors.orange.toString()
                    context.lineWidth = 1.0 / devicePixelRatio
                    context.beginPath()
                    for (let i = 0; i < HISTORY_SIZE; i++) {
                        const bufferIndex = (writeIndex + i) % HISTORY_SIZE
                        const x = (i / HISTORY_SIZE) * actualWidth
                        const y = (1.0 - envelopeHistory[bufferIndex]) * actualHeight
                        if (i === 0) {
                            context.moveTo(x, y)
                        } else {
                            context.lineTo(x, y)
                        }
                    }
                    context.stroke()
                }))
                painter.requestUpdate()
                lifecycle.own(AnimationFrame.add(painter.requestUpdate))
            }}/>
        </div>
    )
}
