import css from "./WaveDisplay.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "NeonWaveDisplay")

type Construct = {
    lifecycle: Lifecycle
    parameter: AutomatableParameterFieldAdapter<number>
    offValue?: boolean // wave2: index 0 renders as "off" (flat), shapes shifted by one
}

const TAU = Math.PI * 2

// The engine's phase maps at FULL DCW (pd.rs), drawn as one cycle of cos(2π·m(x)).
const phaseMap = (wave: number, x: number): number => {
    switch (wave) {
        case 0: {
            const d = 0.022
            return x < d ? 0.5 * x / d : 0.5 + 0.5 * (x - d) / (1.0 - d)
        }
        case 1: {
            const d = 0.03
            if (x < d) {return 0.5 * x / d}
            if (x < 0.5) {return 0.5}
            if (x < 0.5 + d) {return 0.5 + 0.5 * (x - 0.5) / d}
            return 1.0
        }
        case 2: {
            const d = 0.048
            return x < d ? x / d : 1.0
        }
        case 3: {
            const a = 0.975
            return x < a ? x / a : 1.0 + (x - a) / (1.0 - a)
        }
        case 4: {
            const d = 0.022
            if (x < 0.5) {return x}
            if (x < 0.5 + d) {return 0.5 + 0.5 * (x - 0.5) / d}
            return 1.0
        }
        default:
            return x
    }
}

const sample = (wave: number, x: number): number => {
    if (wave < 5) {return Math.cos(TAU * phaseMap(wave, x))}
    const window = wave === 5 ? 1.0 - x : wave === 6 ? 1.0 - Math.abs(2.0 * x - 1.0) : Math.min(2.0 * (1.0 - x), 1.0)
    const k = 6.0
    return window * (Math.cos(TAU * ((x * k) % 1.0)) - 1.0) + 1.0
}

// A one-cycle glyph of the SELECTED CZ waveform (full-DCW shape) — the wave cells' icon.
export const WaveDisplay = ({lifecycle, parameter, offValue}: Construct) => {
    const canvas: HTMLCanvasElement = (<canvas className={className}/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        const value = parameter.getControlledValue()
        const wave = offValue === true ? value - 1 : value
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.lineWidth = devicePixelRatio
        const padding = devicePixelRatio * 2
        const top = padding
        const bottom = actualHeight - padding
        const middle = actualHeight * 0.5
        const amplitude = middle - padding
        const path = new Path2D()
        if (wave < 0) {
            context.setLineDash([devicePixelRatio * 3, devicePixelRatio * 3])
            path.moveTo(0, middle)
            path.lineTo(actualWidth, middle)
        } else {
            for (let x = 0; x <= actualWidth; x++) {
                const y = middle - sample(wave, x / actualWidth) * amplitude
                if (x === 0) {path.moveTo(x, y)} else {path.lineTo(x, y)}
            }
        }
        context.strokeStyle = DisplayPaint.strokeStyle(wave < 0 ? 0.35 : 0.75)
        context.stroke(path)
        context.setLineDash([])
        path.lineTo(actualWidth, middle)
        path.lineTo(0, middle)
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.2))
        gradient.addColorStop(0.5, DisplayPaint.strokeStyle(0.0))
        gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.2))
        context.fillStyle = gradient
        context.fill(path)
        context.beginPath()
        context.moveTo(0, middle)
        context.lineTo(actualWidth, middle)
        context.strokeStyle = "hsla(200, 83%, 60%, 0.25)"
        context.stroke()
    }))
    lifecycle.own(parameter.subscribe(() => painter.requestUpdate()))
    return canvas
}
