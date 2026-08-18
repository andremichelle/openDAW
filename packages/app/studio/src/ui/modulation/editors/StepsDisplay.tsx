import css from "./StepsDisplay.sass?inline"
import {clamp, Editing, Errors, int, Lifecycle, Option, panic, TAU, unitValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Propagation} from "@opendaw/lib-box"
import {CanvasPainter} from "@opendaw/studio-core"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {StepsModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint.ts"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"

const className = Html.adoptStyleSheet(css, "StepsDisplay")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    receiver: LiveStreamReceiver
    modulator: StepsModulatorBoxAdapter
}

export const StepsDisplay = ({lifecycle, editing, receiver, modulator}: Construct): HTMLElement => {
    const canvas: HTMLCanvasElement = (<canvas/>)
    let playhead = 0.0
    let output = 0.0
    let ascending = true
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        context.clearRect(0, 0, actualWidth, actualHeight)
        const count = clamp(modulator.count, 1, StepsModulatorBoxAdapter.MaxSteps)
        const padding = devicePixelRatio * 2
        const top = padding
        const bottom = actualHeight - padding
        const centerY = (top + bottom) / 2
        const valueToY = (value: unitValue) => centerY - value * (bottom - top) / 2
        const stepWidth = actualWidth / count
        const gap = Math.min(devicePixelRatio, stepWidth * 0.1)
        context.fillStyle = DisplayPaint.strokeStyle(0.2)
        for (let index = 0; index < count; index++) {
            const value = modulator.steps[index].getValue()
            const x = index * stepWidth
            const y = valueToY(value)
            context.fillRect(x + gap, Math.min(y, centerY), stepWidth - gap * 2, Math.max(1, Math.abs(y - centerY)))
        }
        context.lineWidth = devicePixelRatio
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.beginPath()
        for (let index = 0; index < count; index++) {
            const y = valueToY(modulator.steps[index].getValue())
            context.moveTo(index * stepWidth + gap, y)
            context.lineTo((index + 1) * stepWidth - gap, y)
        }
        context.stroke()
        context.beginPath()
        for (let x = 0; x <= actualWidth; x++) {
            const y = valueToY(modulator.patternAt(x / stepWidth, ascending))
            if (x === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
        }
        context.strokeStyle = "hsla(200, 83%, 60%, 0.5)"
        context.stroke()
        context.beginPath()
        context.moveTo(0, centerY)
        context.lineTo(actualWidth, centerY)
        context.strokeStyle = "hsla(200, 83%, 60%, 0.25)"
        context.stroke()
        context.beginPath()
        context.arc(playhead * stepWidth, valueToY(output), devicePixelRatio * 2.0, 0.0, TAU)
        context.fillStyle = "hsl(200, 83%, 75%)"
        context.fill()
    }))
    const stepAt = (clientX: number): int => {
        const rect = canvas.getBoundingClientRect()
        const count = clamp(modulator.count, 1, StepsModulatorBoxAdapter.MaxSteps)
        return clamp(Math.floor((clientX - rect.left) / rect.width * count), 0, count - 1)
    }
    const valueAt = (clientY: number): unitValue => {
        const rect = canvas.getBoundingClientRect()
        return clamp(1.0 - (clientY - rect.top) / rect.height * 2.0, -1.0, 1.0)
    }
    const paint = (event: Dragging.Event) => editing.modify(() =>
        modulator.steps[stepAt(event.clientX)].setValue(event.altKey ? 0.0 : valueAt(event.clientY)), false)
    lifecycle.ownAll(
        Dragging.attach(canvas, (event: PointerEvent) => {
            editing.mark()
            paint(event)
            return Option.wrap({
                update: (event: Dragging.Event) => paint(event),
                finally: () => editing.mark()
            })
        }, {permanentUpdates: true}),
        Events.subscribeDblDwn(canvas, async (event: PointerEvent) => {
            const index = stepAt(event.clientX)
            const step = modulator.steps[index]
            const resolvers = Promise.withResolvers<string>()
            Surface.get(canvas).flyout.appendChild(
                <FloatingTextInput position={{x: event.clientX, y: event.clientY}}
                                   value={(step.getValue() * 100.0).toFixed(0)}
                                   unit="%"
                                   numeric
                                   resolvers={resolvers}/>
            )
            const {status, error, value} = await Promises.tryCatch(resolvers.promise)
            if (status === "rejected") {
                if (!Errors.isAbort(error)) {return panic(String(error))}
                return
            }
            const parsed = parseFloat(value)
            if (Number.isFinite(parsed)) {
                editing.modify(() => step.setValue(clamp(parsed / 100.0, -1.0, 1.0)))
            }
        }),
        modulator.box.subscribe(Propagation.Children, painter.requestUpdate),
        receiver.subscribeFloats(modulator.address, ([position, value]) => {
            const delta = position - playhead
            const count = clamp(modulator.count, 1, StepsModulatorBoxAdapter.MaxSteps)
            if (delta !== 0.0 && Math.abs(delta) < count * 0.5) {ascending = delta > 0.0}
            playhead = position
            output = value
            painter.requestUpdate()
        })
    )
    return <div className={className}>{canvas}</div>
}
