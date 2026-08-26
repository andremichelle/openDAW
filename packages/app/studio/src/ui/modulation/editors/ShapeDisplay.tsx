import css from "./ShapeDisplay.sass?inline"
import {Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {CanvasPainter} from "@opendaw/studio-core"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {DisplayPaint} from "@/ui/devices/DisplayPaint.ts"
import {LfoModulatorBoxAdapter, LfoShape} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "ShapeDisplay")

type Construct = {
    lifecycle: Lifecycle
    receiver: LiveStreamReceiver
    modulator: LfoModulatorBoxAdapter
}

// WASM CONTRACT: mirrors the engine's `modulation.rs` shapes.
const shapeAt = (shape: LfoShape, turn: number): number => {
    const phase = turn - Math.floor(turn)
    switch (shape) {
        case LfoShape.Triangle:
            return phase < 0.25 ? phase * 4.0 : phase < 0.75 ? 2.0 - phase * 4.0 : phase * 4.0 - 4.0
        case LfoShape.SawUp:
            return phase * 2.0 - 1.0
        case LfoShape.SawDown:
            return 1.0 - phase * 2.0
        case LfoShape.Square:
            return phase < 0.5 ? 1.0 : -1.0
        default:
            return Math.sin(TAU * phase)
    }
}

export const ShapeDisplay = ({lifecycle, receiver, modulator}: Construct): HTMLElement => {
    const canvas: HTMLCanvasElement = (<canvas/>)
    // The engine's `[phase, value]` for this modulator: the phase already carries the phase parameter, the
    // value is the final output (shaped and scaled by amount), so the dot needs its own mapping.
    let playhead = 0.0
    let output = 0.0
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        context.clearRect(0, 0, actualWidth, actualHeight)
        const shape: LfoShape = modulator.box.shape.getValue()
        const phase = modulator.box.phase.getValue()
        const exponent = Math.pow(LfoModulatorBoxAdapter.ExponentRange, modulator.box.exponent.getValue())
        const shaped = (value: number) => Math.sign(value) * Math.pow(Math.abs(value), exponent)
        const padding = devicePixelRatio * 2
        const top = padding
        const bottom = actualHeight - padding
        const bipolar = modulator.box.bipolar.getValue()
        const emitted = (value: number) => bipolar ? value : value * 0.5 + 0.5
        const valueToY = (value: number) => bottom + (top - bottom) * (bipolar
            ? 0.5 * (emitted(value) + 1.0)
            : emitted(value))
        const centerY = bipolar ? valueToY(0.0) : bottom
        context.lineWidth = devicePixelRatio
        const path = new Path2D()
        path.moveTo(0, valueToY(shaped(shapeAt(shape, phase))))
        for (let x = 1; x <= actualWidth; x++) {
            path.lineTo(x, valueToY(shaped(shapeAt(shape, x / actualWidth + phase))))
        }
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.stroke(path)
        path.lineTo(actualWidth, centerY)
        path.lineTo(0, centerY)
        context.fillStyle = DisplayPaint.baselineGradient(context, top, bottom, bipolar)
        context.fill(path)
        context.beginPath()
        context.moveTo(0, centerY)
        context.lineTo(actualWidth, centerY)
        context.strokeStyle = "hsla(200, 83%, 60%, 0.25)"
        context.stroke()
        const turn = playhead - phase - Math.floor(playhead - phase)
        context.beginPath()
        context.arc(turn * actualWidth,
            bottom + (top - bottom) * (bipolar ? 0.5 * (output + 1.0) : output),
            devicePixelRatio * 2.0, 0.0, TAU)
        context.fillStyle = "hsl(200, 83%, 75%)"
        context.fill()
    }))
    lifecycle.ownAll(
        modulator.box.shape.subscribe(painter.requestUpdate),
        modulator.box.phase.subscribe(painter.requestUpdate),
        modulator.box.bipolar.subscribe(painter.requestUpdate),
        modulator.box.exponent.subscribe(painter.requestUpdate),
        receiver.subscribeFloats(modulator.address, ([position, value]) => {
            playhead = position
            output = value
            painter.requestUpdate()
        })
    )
    return <div className={className}>{canvas}</div>
}
