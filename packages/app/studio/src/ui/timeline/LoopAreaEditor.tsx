import css from "./LoopAreaEditor.sass?inline"
import {asDefined, Lifecycle, Nullable, Option} from "@opendaw/lib-std"
import {CssUtils, deferNextFrame, Dragging, Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {BoxEditing, Propagation} from "@opendaw/lib-box"
import {installCursor} from "@/ui/hooks/cursor.ts"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {LoopArea} from "@opendaw/studio-boxes"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "loop-area-editor")

const CursorMap = {
    "loop-start": "w-resize",
    "loop-end": "e-resize",
    "loop-body": "ew-resize"
} satisfies Record<string, CssUtils.Cursor>

type Target = keyof typeof CursorMap

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    range: TimelineRange
    snapping: Snapping
    loopArea: LoopArea
}

export const LoopAreaEditor = ({lifecycle, editing, range, snapping, loopArea}: Construct) => {
    const {from: loopFrom, to: loopTo} = loopArea
    const canvas: HTMLCanvasElement = <canvas/>
    const capturing = new ElementCapturing<Target>(canvas, {
        capture: (x: number, _y: number): Nullable<Target> => {
            const {clientHeight: height} = canvas
            const handleSize = height
            const x0 = range.unitToX(loopFrom.getValue())
            const x1 = range.unitToX(loopTo.getValue())
            if (x0 < x && x < x1) {return "loop-body"}
            if (Math.abs(x0 - x) < handleSize) {return "loop-start"}
            if (Math.abs(x1 - x) < handleSize) {return "loop-end"}
            return null
        }
    })

    const context: CanvasRenderingContext2D = asDefined(canvas.getContext("2d"), "Could not create 2d context")
    const radiiLeft = [999, 0, 0, 999]
    const radiiRight = [0, 999, 999, 0]
    const {request: requestRender, immediate: immediateRender} = deferNextFrame(() => {
        const {width, height} = canvas
        context.clearRect(0, 0, width, height)
        context.globalAlpha = loopArea.enabled.getValue() ? 1.0 : 0.25
        const x0 = Math.floor(range.unitToX(loopFrom.getValue()) * devicePixelRatio)
        const x1 = Math.floor(range.unitToX(loopTo.getValue()) * devicePixelRatio)
        const handleSize = height
        const handleY = 0
        context.fillStyle = "rgba(255, 255, 255, 0.1)"
        context.fillRect(x0, handleY, x1 - x0, handleSize)
        context.fillStyle = Colors.yellow.toString()
        context.beginPath()
        context.roundRect(x0 - handleSize, handleY, handleSize, handleSize, radiiLeft)
        context.roundRect(x1, handleY, handleSize, handleSize, radiiRight)
        context.fill()
        context.globalAlpha = 1.0
    })
    lifecycle.ownAll(
        Events.subscribeDblDwn(canvas, event => {
            const target = capturing.captureEvent(event)
            if (target === null) {return}
            editing.modify(() => loopArea.enabled.setValue(!loopArea.enabled.getValue()))
        }),
        Dragging.attach(canvas, (event: PointerEvent) => {
            const target = capturing.captureEvent(event)
            if (target === null) {return Option.None}
            const pointerPulse = range.xToUnit(event.clientX)
            const wasLoopFrom = loopFrom.getValue()
            const wasLoopTo = loopTo.getValue()
            const referencePulse = target === "loop-end" ? wasLoopTo : wasLoopFrom
            const length = loopTo.getValue() - loopFrom.getValue()
            return Option.wrap({
                update: (event: Dragging.Event) => {
                    editing.modify(() => {
                        const delta = snapping.computeDelta(pointerPulse, event.clientX, referencePulse)
                        const position = Math.max(0, referencePulse + delta)
                        if (target === "loop-start") {
                            loopFrom.setValue(position)
                        } else if (target === "loop-end") {
                            loopTo.setValue(position)
                        } else if (target === "loop-body") {
                            loopFrom.setValue(position)
                            loopTo.setValue(position + length)
                        }
                    }, false)
                },
                approve: () => editing.mark(),
                cancel: () => editing.modify(() => {
                    loopFrom.setValue(wasLoopFrom)
                    loopTo.setValue(wasLoopTo)
                }),
                finally: () => {}
            })
        }))
    const onResize = () => {
        if (!canvas.isConnected) {return}
        const {clientWidth, clientHeight} = canvas
        range.width = clientWidth
        canvas.width = clientWidth * devicePixelRatio
        canvas.height = clientHeight * devicePixelRatio
        immediateRender()
    }
    lifecycle.own(Html.watchResize(canvas, onResize))
    lifecycle.own(range.subscribe(requestRender))
    lifecycle.own(loopArea.box.subscribe(Propagation.Children, requestRender))
    lifecycle.own(installCursor(canvas, capturing, {get: target => target === null ? null : CursorMap[target]}))
    return <div className={className}>{canvas}</div>
}