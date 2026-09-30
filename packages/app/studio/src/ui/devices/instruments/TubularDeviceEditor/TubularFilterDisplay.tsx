import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

type Construct = {
    lifecycle: Lifecycle
    cutoff: AutomatableParameterFieldAdapter<number>
    resonance: AutomatableParameterFieldAdapter<number>
}

// The output low-pass as a magnitude curve on a log axis (60 Hz to 19 kHz, Dexed's cutoff mapping),
// 24 dB per octave with a resonance peak; flat when the cutoff is fully open (the filter is bypassed).
export const TubularFilterDisplay = ({lifecycle, cutoff, resonance}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas/>
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        const padding = devicePixelRatio * 4
        const top = padding
        const bottom = actualHeight - padding
        const cut = cutoff.getValue()
        const reso = resonance.getValue()
        const rolloff = 19.0
        const hz = (Math.exp(cut * Math.log(rolloff + 1.0)) - 1.0) / rolloff * (19000.0 - 60.0) + 60.0
        const bypass = cut >= 1.0
        const minDb = -48.0
        const maxDb = 18.0
        const dbToY = (db: number) => bottom - (db - minDb) / (maxDb - minDb) * (bottom - top)
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.lineWidth = devicePixelRatio
        context.setLineDash([2, 3])
        context.strokeStyle = "rgba(255, 255, 255, 0.08)"
        context.beginPath()
        context.moveTo(0, dbToY(0.0))
        context.lineTo(actualWidth, dbToY(0.0))
        context.stroke()
        context.setLineDash([])
        const path = new Path2D()
        for (let x = 0; x <= actualWidth; x++) {
            const frequency = 20.0 * Math.pow(1000.0, x / actualWidth)
            const octaves = Math.log2(frequency / hz)
            const db = bypass ? 0.0
                : -24.0 * Math.max(0.0, octaves) + reso * 20.0 * Math.exp(-octaves * octaves / 0.18)
            const y = Math.max(top, Math.min(bottom, dbToY(db)))
            if (x === 0) {path.moveTo(x, y)} else {path.lineTo(x, y)}
        }
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.stroke(path)
        path.lineTo(actualWidth, bottom)
        path.lineTo(0, bottom)
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.12))
        gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.0))
        context.fillStyle = gradient
        context.fill(path)
    }))
    lifecycle.ownAll(
        cutoff.subscribe(() => painter.requestUpdate()),
        resonance.subscribe(() => painter.requestUpdate())
    )
    return canvas
}
