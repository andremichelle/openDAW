import css from "./DuckerDisplay.sass?inline"
import {clamp, Editing, EmptyExec, Lifecycle, Option, Procedure} from "@opendaw/lib-std"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {LinearMatrixDuckerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"
import {Surface} from "@/ui/surface/Surface"
import {DuckerHistory, DuckerScale} from "./DuckerHistory"

const className = Html.adoptStyleSheet(css, "DuckerDisplay")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: LinearMatrixDuckerDeviceBoxAdapter
    history: DuckerHistory
    onPainter: Procedure<CanvasPainter>
}

const GrabDistance = 6
const HandleSize = 5

export const DuckerDisplay = ({lifecycle, editing, adapter, history, onPainter}: Construct) => {
    const {threshold, range} = adapter.namedParameter
    const canvas: HTMLCanvasElement = <canvas/>
    const thresholdY = (height: number) => height * (1.0 - DuckerScale.dbToUnit(threshold.getControlledValue()))
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        context.clearRect(0, 0, actualWidth, actualHeight)
        const columns = Math.min(Math.ceil(actualWidth / devicePixelRatio), history.capacity)
        const step = devicePixelRatio
        const area = (value: number, map: (value: number) => number): Path2D => {
            const path = new Path2D()
            path.moveTo(actualWidth, actualHeight)
            for (let age = 0; age < columns; age++) {
                path.lineTo(actualWidth - age * step, actualHeight * (1.0 - map(history.value(age, value))))
            }
            path.lineTo(actualWidth - (columns - 1) * step, actualHeight)
            path.closePath()
            return path
        }
        const sidechained = adapter.sideChain.nonEmpty()
        const grey = area(sidechained ? 2 : 0, DuckerScale.gainToUnit)
        context.fillStyle = Colors.white.opacity(0.18).toString()
        context.fill(grey)
        context.strokeStyle = Colors.white.opacity(0.35).toString()
        context.lineWidth = devicePixelRatio
        context.stroke(grey)
        const blue = area(1, DuckerScale.gainToUnit)
        const gradient = context.createLinearGradient(0, 0, 0, actualHeight)
        gradient.addColorStop(0.0, Colors.blue.opacity(0.5).toString())
        gradient.addColorStop(1.0, Colors.blue.opacity(0.05).toString())
        context.fillStyle = gradient
        context.fill(blue)
        context.strokeStyle = Colors.blue.toString()
        context.lineWidth = devicePixelRatio * 1.5
        context.stroke(blue)
        const reduction = new Path2D()
        for (let age = 0; age < columns; age++) {
            const y = actualHeight * (1.0 - DuckerScale.reductionToUnit(history.value(age, 3)))
            if (age === 0) {reduction.moveTo(actualWidth, y)} else {reduction.lineTo(actualWidth - age * step, y)}
        }
        context.strokeStyle = Colors.white.opacity(0.8).toString()
        context.lineWidth = devicePixelRatio
        context.stroke(reduction)
        const rangeValue = range.getControlledValue()
        if (rangeValue > 0.0 && rangeValue < 1.0) {
            const floorDb = threshold.getControlledValue() + 20.0 * Math.log10(1.0 - rangeValue)
            const y = Math.round(actualHeight * (1.0 - DuckerScale.dbToUnit(floorDb)))
            context.fillStyle = Colors.blue.toString()
            context.fillRect(0, y - devicePixelRatio * 0.5, actualWidth, devicePixelRatio)
        }
        const y = Math.round(thresholdY(actualHeight))
        context.fillStyle = Colors.white.toString()
        context.fillRect(0, y - devicePixelRatio * 0.5, actualWidth, devicePixelRatio)
        const size = HandleSize * devicePixelRatio
        context.beginPath()
        context.moveTo(0, y - size)
        context.lineTo(size * 1.4, y)
        context.lineTo(0, y + size)
        context.closePath()
        context.fill()
    }))
    onPainter(painter)
    const nearThreshold = (event: PointerEvent | MouseEvent): boolean => {
        const rect = canvas.getBoundingClientRect()
        return Math.abs(event.clientY - rect.top - thresholdY(rect.height)) <= GrabDistance
    }
    lifecycle.ownAll(
        threshold.subscribe(painter.requestUpdate),
        range.subscribe(painter.requestUpdate),
        adapter.sideChain.subscribe(painter.requestUpdate),
        Events.subscribe(canvas, "pointermove", event =>
            canvas.classList.toggle("grab", nearThreshold(event))),
        Dragging.attach(canvas, event => {
            if (!nearThreshold(event)) {return Option.None}
            const rect = canvas.getBoundingClientRect()
            const startY = thresholdY(rect.height)
            const startValue = threshold.getValue()
            editing.mark()
            return Option.wrap({
                update: (position: Dragging.Event) => {
                    const y = startY + position.clientY - event.clientY
                    const db = DuckerScale.unitToDb(1.0 - y / rect.height)
                    editing.modify(() => threshold.setValue(clamp(db, -60.0, 6.0)), false)
                },
                cancel: () => editing.modify(() => threshold.setValue(startValue), false),
                approve: () => editing.mark()
            })
        }),
        Events.subscribe(canvas, "dblclick", event => {
            if (!nearThreshold(event)) {return}
            const rect = canvas.getBoundingClientRect()
            const printValue = threshold.getPrintValue()
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then(value => {
                editing.modify(() => threshold.setPrintValue(value))
                editing.mark()
            }, EmptyExec)
            Surface.get(canvas).flyout.appendChild(
                <FloatingTextInput position={{x: rect.left, y: rect.top + thresholdY(rect.height)}}
                                   value={printValue.value}
                                   unit={printValue.unit}
                                   numeric
                                   resolvers={resolvers}/>
            )
        })
    )
    return <div className={className}>{canvas}</div>
}
