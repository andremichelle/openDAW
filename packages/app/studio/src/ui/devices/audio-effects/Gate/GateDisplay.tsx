import css from "./GateDisplay.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {clamp, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "GateDisplay")

type Construct = {
    lifecycle: Lifecycle
    values: Float32Array  // [inputPeakDb, outputPeakDb, gateEnvelope, thresholdDb]
}

const DB_MIN = -80.0
const DB_MAX = 0.0

const dbToY = (db: number, height: number): number => {
    const normalized = clamp((db - DB_MIN) / (DB_MAX - DB_MIN), 0.0, 1.0)
    return height * (1.0 - normalized)
}

export const GateDisplay = ({lifecycle, values}: Construct) => {
    const width = 216
    const height = 64
    const canvas = <canvas width={width} height={height}/> as HTMLCanvasElement
    const ctx = canvas.getContext("2d")!

    // Colors
    const inputColor = "rgba(255, 255, 255, 0.4)"
    const outputColor = "#ff9500" // Orange
    const thresholdColor = "rgba(255, 255, 255, 0.3)"
    const gateOpenColor = "rgba(0, 255, 0, 0.5)"
    const gateClosedColor = "rgba(255, 0, 0, 0.3)"

    // Initialize canvas with black background
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)"
    ctx.fillRect(0, 0, width, height)

    lifecycle.own(AnimationFrame.add(() => {
        const [inputPeakDb, outputPeakDb, gateEnvelope, thresholdDb] = values

        // Shift canvas content left by 1 pixel
        ctx.drawImage(canvas, -1, 0)

        // Clear the rightmost column
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)"
        ctx.fillRect(width - 1, 0, 1, height)

        // Draw gate state indicator at bottom (1px wide bar)
        ctx.fillStyle = gateEnvelope > 0.5 ? gateOpenColor : gateClosedColor
        ctx.fillRect(width - 1, height - 3, 1, 3)

        // Draw threshold line
        const thresholdY = dbToY(thresholdDb, height - 4)
        ctx.fillStyle = thresholdColor
        ctx.fillRect(width - 1, thresholdY, 1, 1)

        // Draw input peak (light)
        const inputY = dbToY(inputPeakDb, height - 4)
        ctx.fillStyle = inputColor
        ctx.fillRect(width - 1, inputY, 1, height - 4 - inputY)

        // Draw output peak (orange) on top
        const outputY = dbToY(outputPeakDb, height - 4)
        ctx.fillStyle = outputColor
        ctx.fillRect(width - 1, outputY, 1, height - 4 - outputY)
    }))

    return (
        <div classList={className}>
            {canvas}
        </div>
    )
}
