import {clamp, DefaultObservableValue, Editing, int, Lifecycle} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const STAGES = 4
const HOLD = 0.4 // the sustain hold between stage 3 and the release, in stage slots

type Parameter = AutomatableParameterFieldAdapter<number>

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    rates: ReadonlyArray<Parameter>
    levels: ReadonlyArray<Parameter>
    // The pitch envelope: level 50 is the centre line and the curve starts at L4 (the DX7 holds it there).
    centred?: boolean
}

// The DX7 four-stage envelope: rates 1-3 run from key-on through L1, L2 to L3 (held while the key is down),
// rate 4 releases to L4. A segment's width follows its rate (99 = instant, 0 = slowest), so the drawing
// reads like Dexed's. Drag a point: horizontal = rate, vertical = level, shift = fine.
export const DxEnvelopeEditor = ({lifecycle, editing, rates, levels, centred}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas/>
    const selectedStage = lifecycle.own(new DefaultObservableValue<int>(0))
    // Segment widths as fractions of the canvas: each stage grows as its rate slows, the sustain hold after
    // stage 3 keeps a fixed share, all normalised to the full width.
    const layout = (rateValues: ReadonlyArray<number>): {widths: ReadonlyArray<number>, hold: number, xs: ReadonlyArray<number>} => {
        const raw = rateValues.map(rate => 0.12 + 0.88 * (1.0 - rate / 99.0))
        const total = raw.reduce((sum, width) => sum + width, 0.0) + HOLD
        const widths = raw.map(width => width / total)
        const hold = HOLD / total
        const xs = [
            widths[0],
            widths[0] + widths[1],
            widths[0] + widths[1] + widths[2],
            widths[0] + widths[1] + widths[2] + hold + widths[3]
        ]
        return {widths, hold, xs}
    }
    const startLevel = (levelValues: ReadonlyArray<number>): number => centred === true ? levelValues[3] : 0.0
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        const rateValues = rates.map(parameter => parameter.getValue())
        const levelValues = levels.map(parameter => parameter.getValue())
        const {xs, hold} = layout(rateValues)
        const padding = devicePixelRatio * 4
        const top = padding
        const bottom = actualHeight - padding
        const stageX = (x: number) => padding + x * (actualWidth - padding * 2)
        const levelToY = (level: number) => bottom + (top - bottom) * (level / 99.0)
        const baseline = levelToY(centred === true ? 50.0 : 0.0)
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.lineWidth = devicePixelRatio
        context.setLineDash([2, 3])
        context.strokeStyle = "rgba(255, 255, 255, 0.08)"
        context.beginPath()
        for (let stage = 0; stage < STAGES; stage++) {
            context.moveTo(stageX(xs[stage]), top)
            context.lineTo(stageX(xs[stage]), bottom)
        }
        if (centred === true) {
            context.moveTo(0, baseline)
            context.lineTo(actualWidth, baseline)
        }
        context.stroke()
        context.setLineDash([])
        const path = new Path2D()
        path.moveTo(stageX(0.0), levelToY(startLevel(levelValues)))
        for (let stage = 0; stage < STAGES; stage++) {
            path.lineTo(stageX(xs[stage]), levelToY(levelValues[stage]))
            if (stage === 2) {
                path.lineTo(stageX(xs[2] + hold), levelToY(levelValues[2]))
            }
        }
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.stroke(path)
        path.lineTo(stageX(xs[3]), baseline)
        path.lineTo(stageX(0.0), baseline)
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.12))
        gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.0))
        context.fillStyle = gradient
        context.fill(path)
        const selected = selectedStage.getValue()
        for (let stage = 0; stage < STAGES; stage++) {
            context.beginPath()
            context.arc(stageX(xs[stage]), levelToY(levelValues[stage]), devicePixelRatio * (stage === selected ? 3.0 : 2.5), 0.0, Math.PI * 2)
            context.fillStyle = DisplayPaint.strokeStyle(stage === selected ? 1.0 : 0.7)
            context.fill()
        }
    }))
    lifecycle.ownAll(
        ...rates.map(parameter => parameter.subscribe(() => painter.requestUpdate())),
        ...levels.map(parameter => parameter.subscribe(() => painter.requestUpdate())),
        selectedStage.subscribe(() => painter.requestUpdate()),
        Events.subscribe(canvas, "pointerdown", (event: PointerEvent) => {
            canvas.setPointerCapture(event.pointerId)
            const rect = canvas.getBoundingClientRect()
            const {xs} = layout(rates.map(parameter => parameter.getValue()))
            const downX = event.clientX
            const downY = event.clientY
            const inset = 4
            const distances = xs.map((x, stage) => Math.hypot(
                rect.left + inset + x * (rect.width - inset * 2) - downX,
                rect.top + inset + (rect.height - inset * 2) * (1.0 - levels[stage].getValue() / 99.0) - downY))
            const stage = distances.indexOf(Math.min(...distances))
            const startRate = rates[stage].getValue()
            const startLevelValue = levels[stage].getValue()
            selectedStage.setValue(stage)
            const move = (moveEvent: PointerEvent) => {
                const fine = moveEvent.shiftKey ? 0.25 : 1.0
                const deltaRate = (moveEvent.clientX - downX) / (rect.width / (STAGES + HOLD)) * 99.0 * fine
                const deltaLevel = (downY - moveEvent.clientY) / rect.height * 99.0 * fine
                const rate = Math.round(clamp(startRate - deltaRate, 0.0, 99.0))
                const level = Math.round(clamp(startLevelValue + deltaLevel, 0.0, 99.0))
                editing.modify(() => {
                    rates[stage].setValue(rate)
                    levels[stage].setValue(level)
                }, false)
            }
            const up = () => {
                canvas.removeEventListener("pointermove", move)
                canvas.removeEventListener("pointerup", up)
                editing.mark()
            }
            canvas.addEventListener("pointermove", move)
            canvas.addEventListener("pointerup", up)
        })
    )
    return canvas
}
