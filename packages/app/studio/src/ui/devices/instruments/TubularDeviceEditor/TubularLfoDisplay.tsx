import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

type Construct = {
    lifecycle: Lifecycle
    wave: AutomatableParameterFieldAdapter<number>
    speed: AutomatableParameterFieldAdapter<number>
    delay: AutomatableParameterFieldAdapter<number>
}

// The LFO shape over a few cycles (more with speed), dimmed across the delay ramp.
export const TubularLfoDisplay = ({lifecycle, wave, speed, delay}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas/>
    const shape = (kind: number, phase: number): number => {
        const t = phase - Math.floor(phase)
        switch (kind) {
            case 0: return t < 0.5 ? 4.0 * t - 1.0 : 3.0 - 4.0 * t
            case 1: return 1.0 - 2.0 * t
            case 2: return 2.0 * t - 1.0
            case 3: return t < 0.5 ? 1.0 : -1.0
            case 4: return Math.sin(t * Math.PI * 2.0)
            default: {
                const n = Math.floor(phase)
                return Math.sin(n * 127.1) * 43758.5453 % 2.0 - 1.0
            }
        }
    }
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        const padding = devicePixelRatio * 4
        const cycles = 2.0 + speed.getValue() / 99.0 * 6.0
        const ramp = delay.getValue() / 99.0
        const mid = actualHeight / 2
        const amplitude = (actualHeight - padding * 2) / 2
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.lineWidth = devicePixelRatio
        context.setLineDash([2, 3])
        context.strokeStyle = "rgba(255, 255, 255, 0.08)"
        context.beginPath()
        context.moveTo(0, mid)
        context.lineTo(actualWidth, mid)
        context.stroke()
        context.setLineDash([])
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.beginPath()
        for (let x = 0; x <= actualWidth; x++) {
            const u = x / actualWidth
            const gain = ramp > 0.0 ? Math.min(1.0, u / ramp) : 1.0
            const y = mid - shape(wave.getValue(), u * cycles) * amplitude * gain
            if (x === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
        }
        context.stroke()
    }))
    lifecycle.ownAll(
        wave.subscribe(() => painter.requestUpdate()),
        speed.subscribe(() => painter.requestUpdate()),
        delay.subscribe(() => painter.requestUpdate())
    )
    return canvas
}
