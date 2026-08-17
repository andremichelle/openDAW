import {Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {LfoModulatorBoxAdapter, LfoShape} from "@opendaw/studio-adapters"

type Construct = {
    lifecycle: Lifecycle
    modulator: LfoModulatorBoxAdapter
}

// WASM CONTRACT: mirrors the engine's `modulation.rs` shapes.
const shapeAt = (shape: LfoShape, turn: number): number => {
    const phase = turn - Math.floor(turn)
    switch (shape) {
        case LfoShape.Triangle:
            return phase < 0.25 ? phase * 4.0 : phase < 0.75 ? 2.0 - phase * 4.0 : phase * 4.0 - 4.0
        case LfoShape.Saw:
            return phase * 2.0 - 1.0
        case LfoShape.Square:
            return phase < 0.5 ? 1.0 : -1.0
        default:
            return Math.sin(TAU * phase)
    }
}

export const ShapeDisplay = ({lifecycle, modulator}: Construct): HTMLElement => {
    const canvas: HTMLCanvasElement = (<canvas className="shape"/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth: width, actualHeight: height, devicePixelRatio: ratio} = painter
        context.clearRect(0, 0, width, height)
        const shape: LfoShape = modulator.box.shape.getValue()
        const phase = modulator.box.phase.getValue()
        const amount = modulator.box.amount.getValue()
        const middle = height / 2
        const scale = (height / 2 - 2 * ratio) * amount
        context.strokeStyle = "rgba(255, 255, 255, 0.15)"
        context.lineWidth = ratio
        context.beginPath()
        context.moveTo(0, middle)
        context.lineTo(width, middle)
        context.stroke()
        context.strokeStyle = "hsl(200, 83%, 60%)"
        context.lineWidth = 1.5 * ratio
        context.beginPath()
        const steps = Math.max(2, Math.floor(width))
        for (let step = 0; step <= steps; step++) {
            const turn = step / steps
            const x = turn * width
            const y = middle - shapeAt(shape, turn + phase) * scale
            if (step === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
        }
        context.stroke()
    }))
    lifecycle.ownAll(
        modulator.box.shape.subscribe(painter.requestUpdate),
        modulator.box.phase.subscribe(painter.requestUpdate),
        modulator.box.amount.subscribe(painter.requestUpdate)
    )
    return canvas
}
