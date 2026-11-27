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
        context.lineWidth = ratio
        for (const hz of CorrodeCurve.GridFrequencies) {
            const x = Math.round(frequency.valueMapping.x(hz) * width)
            context.fillStyle = DisplayPaint.gridStyle(CorrodeCurve.isDecade(hz) ? 0.24 : 0.08)
            context.fillRect(x, 0, ratio, height)
        }
        context.fillStyle = DisplayPaint.gridStyle(0.16)
        for (let row = 1; row < Rows; row++) {
            context.fillRect(0, Math.round(height * row / Rows), width, ratio)
        }
        const sine = mode.getControlledValue() === CorrodeDeviceBoxAdapter.SineMode
        const handleX = frequency.getControlledUnitValue() * width
        const handleY = (1.0 - amount.getControlledUnitValue()) * height
        if (!sine) {
            const center = frequency.getControlledValue()
            const q = CorrodeDeviceBoxAdapter.widthToQ(bandwidth.getControlledValue())
            context.beginPath()
            for (let x = 0; x <= width; x += ratio) {
                const hz = frequency.valueMapping.y(x / width)
                const y = CorrodeCurve.curveY(CorrodeCurve.magnitudeDb(hz, center, q)) * height
                if (x === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
            }
            context.strokeStyle = Colors.blue.toString()
            context.lineWidth = ratio * 1.5
            context.stroke()
        }
        context.beginPath()
        if (sine) {
            context.arc(handleX, handleY, HandleRadius * ratio, 0.0, TAU)
            context.fillStyle = Colors.orange.toString()
            context.fill()
        } else {
            context.arc(handleX, handleY, (HandleRadius - 0.75) * ratio, 0.0, TAU)
            context.strokeStyle = Colors.orange.toString()
            context.lineWidth = ratio * 1.5
            context.stroke()
        }
    }))
    lifecycle.ownAll(
        ...[mode, frequency, bandwidth, amount].map(parameter => parameter.subscribe(painter.requestUpdate)),
        Dragging.attach(canvas, event => {
            const rect = canvas.getBoundingClientRect()
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
