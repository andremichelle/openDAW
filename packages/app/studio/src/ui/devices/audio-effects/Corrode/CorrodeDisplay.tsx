import css from "./CorrodeDisplay.sass?inline"
import {clamp, Editing, Lifecycle, Option, TAU} from "@opendaw/lib-std"
import {Dragging, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {CorrodeDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {CorrodeCurve} from "./CorrodeCurve"

const className = Html.adoptStyleSheet(css, "CorrodeDisplay")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: CorrodeDeviceBoxAdapter
}

const HandleRadius = 6
const Rows = 5

export const CorrodeDisplay = ({lifecycle, editing, adapter}: Construct) => {
    const {mode, frequency, width: bandwidth, amount} = adapter.namedParameter
    const canvas: HTMLCanvasElement = <canvas/>
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth: width, actualHeight: height, devicePixelRatio: ratio} = painter
        context.clearRect(0, 0, width, height)
        const inset = HandleRadius * ratio
        const plotWidth = width - 2.0 * inset
        const plotHeight = height - 2.0 * inset
        context.fillStyle = DisplayPaint.gridStyle(0.06)
        for (const hz of CorrodeCurve.GridFrequencies) {
            context.fillRect(Math.round(inset + frequency.valueMapping.x(hz) * plotWidth), 0, 1, height)
        }
        for (let row = 1; row < Rows; row++) {
            context.fillRect(0, Math.round(inset + plotHeight * row / Rows), width, 1)
        }
        const sine = mode.getControlledValue() === CorrodeDeviceBoxAdapter.SineMode
        const handleX = inset + frequency.getControlledUnitValue() * plotWidth
        const peak = 1.0 - amount.getControlledUnitValue()
        const handleY = inset + peak * plotHeight
        if (!sine) {
            const center = frequency.getControlledValue()
            const q = CorrodeDeviceBoxAdapter.widthToQ(bandwidth.getControlledValue())
            const low = frequency.valueMapping.y(0.0)
            const high = frequency.valueMapping.y(1.0)
            const path = new Path2D()
            for (let x = 0; x <= width; x += ratio) {
                const hz = low * Math.pow(high / low, (x - inset) / plotWidth)
                const db = CorrodeCurve.magnitudeDb(hz, center, q)
                const y = Math.min(inset + CorrodeCurve.curveY(db, peak) * plotHeight, height + 2.0 * ratio)
                if (x === 0) {path.moveTo(x, y)} else {path.lineTo(x, y)}
            }
            context.strokeStyle = DisplayPaint.strokeStyle(0.75)
            context.lineWidth = ratio * 1.5
            context.stroke(path)
            path.lineTo(width, height + 2.0 * ratio)
            path.lineTo(0, height + 2.0 * ratio)
            const gradient = context.createLinearGradient(0, handleY, 0, height)
            gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.08))
            gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.02))
            context.fillStyle = gradient
            context.fill(path)
        }
        context.beginPath()
        context.arc(handleX, handleY, HandleRadius * ratio, 0.0, TAU)
        context.fillStyle = Colors.orange.toString()
        context.fill()
    }))
    lifecycle.ownAll(
        ...[mode, frequency, bandwidth, amount].map(parameter => parameter.subscribe(painter.requestUpdate)),
        Dragging.attach(canvas, event => {
            const {left, top, width, height} = canvas.getBoundingClientRect()
            const rect = {
                left: left + HandleRadius, top: top + HandleRadius,
                width: width - 2.0 * HandleRadius, height: height - 2.0 * HandleRadius
            }
            const start = {frequency: frequency.getValue(), width: bandwidth.getValue(), amount: amount.getValue()}
            const anchor = {alt: event.altKey, y: event.clientY, width: bandwidth.getUnitValue()}
            const apply = (position: Dragging.Event) => {
                if (position.altKey !== anchor.alt) {
                    anchor.alt = position.altKey
                    anchor.y = position.clientY
                    anchor.width = bandwidth.getUnitValue()
                }
                editing.modify(() => {
                    frequency.setUnitValue(clamp((position.clientX - rect.left) / rect.width, 0.0, 1.0))
                    if (!position.altKey) {
                        amount.setUnitValue(clamp(1.0 - (position.clientY - rect.top) / rect.height, 0.0, 1.0))
                    } else if (mode.getValue() !== CorrodeDeviceBoxAdapter.SineMode) {
                        bandwidth.setUnitValue(clamp(anchor.width + (anchor.y - position.clientY) / rect.height, 0.0, 1.0))
                    }
                }, false)
            }
            editing.mark()
            apply(event)
            return Option.wrap({
                update: apply,
                cancel: () => editing.modify(() => {
                    frequency.setValue(start.frequency)
                    bandwidth.setValue(start.width)
                    amount.setValue(start.amount)
                }, false),
                approve: () => editing.mark()
            })
        })
    )
    return <div className={className}>{canvas}</div>
}
