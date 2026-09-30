import {clamp, Editing, Lifecycle} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {TubularDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    operator: TubularDeviceBoxAdapter["namedParameter"]["operators"][number]
}

// Keyboard level scaling: the level offset across the keyboard, falling or rising away from the break
// point with the left and right depth and curve (-LIN, -EXP, +EXP, +LIN). Drag the nearest handle: the
// break point moves horizontally, an end moves vertically through zero (flipping the curve's sign), shift
// = fine.
export const TubularScalingDisplay = ({lifecycle, editing, operator}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas/>
    const {breakPoint, leftDepth, rightDepth, leftCurve, rightCurve} = operator
    const shape = (curve: number, distance: number): number => {
        const magnitude = curve === 0 || curve === 3 ? distance : (Math.exp(distance * 4.0) - 1.0) / (Math.exp(4.0) - 1.0)
        return curve < 2 ? -magnitude : magnitude
    }
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        const padding = devicePixelRatio * 3
        const mid = actualHeight / 2
        const amplitude = mid - padding
        const split = breakPoint.getValue() / 99.0
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.lineWidth = devicePixelRatio
        context.setLineDash([2, 3])
        context.strokeStyle = "rgba(255, 255, 255, 0.08)"
        context.beginPath()
        context.moveTo(0, mid)
        context.lineTo(actualWidth, mid)
        context.moveTo(split * actualWidth, padding)
        context.lineTo(split * actualWidth, actualHeight - padding)
        context.stroke()
        context.setLineDash([])
        const offsetAt = (key: number): number => key < split
            ? shape(leftCurve.getValue(), (split - key) / Math.max(split, 1e-3)) * leftDepth.getValue() / 99.0
            : shape(rightCurve.getValue(), (key - split) / Math.max(1.0 - split, 1e-3)) * rightDepth.getValue() / 99.0
        const inset = devicePixelRatio * 3
        const keyToX = (key: number) => inset + key * (actualWidth - inset * 2)
        context.strokeStyle = DisplayPaint.strokeStyle(0.75)
        context.beginPath()
        for (let x = 0; x <= actualWidth; x++) {
            const key = (x - inset) / (actualWidth - inset * 2)
            const y = mid - offsetAt(clamp(key, 0.0, 1.0)) * amplitude
            if (x === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
        }
        context.stroke()
        context.fillStyle = DisplayPaint.strokeStyle(0.9)
        for (const [x, y] of [
            [keyToX(0.0), mid - offsetAt(0.0) * amplitude],
            [keyToX(split), mid],
            [keyToX(1.0), mid - offsetAt(1.0) * amplitude]
        ]) {
            context.beginPath()
            context.arc(x, y, devicePixelRatio * 2.5, 0.0, Math.PI * 2)
            context.fill()
        }
    }))
    lifecycle.ownAll(
        ...[breakPoint, leftDepth, rightDepth, leftCurve, rightCurve]
            .map(parameter => parameter.subscribe(() => painter.requestUpdate())),
        Events.subscribe(canvas, "pointerdown", (event: PointerEvent) => {
            canvas.setPointerCapture(event.pointerId)
            const rect = canvas.getBoundingClientRect()
            const downX = event.clientX
            const downY = event.clientY
            const split = breakPoint.getValue() / 99.0
            const handles: ReadonlyArray<number> = [0.0, split, 1.0]
            const handle = handles
                .map((key, index) => ({index, distance: Math.abs(rect.left + key * rect.width - downX)}))
                .reduce((best, entry) => entry.distance < best.distance ? entry : best).index
            const startBreak = breakPoint.getValue()
            const depth = handle === 0 ? leftDepth : rightDepth
            const curve = handle === 0 ? leftCurve : rightCurve
            const linear = curve.getValue() === 0 || curve.getValue() === 3
            const startSigned = (curve.getValue() < 2 ? -1.0 : 1.0) * depth.getValue()
            const move = (moveEvent: PointerEvent) => {
                const fine = moveEvent.shiftKey ? 0.25 : 1.0
                if (handle === 1) {
                    const delta = (moveEvent.clientX - downX) / rect.width * 99.0 * fine
                    editing.modify(() => breakPoint.setValue(Math.round(clamp(startBreak + delta, 0.0, 99.0))), false)
                } else {
                    const delta = (downY - moveEvent.clientY) / (rect.height / 2) * 99.0 * fine
                    const signed = clamp(startSigned + delta, -99.0, 99.0)
                    editing.modify(() => {
                        depth.setValue(Math.round(Math.abs(signed)))
                        if (signed !== 0.0) {curve.setValue(signed < 0.0 ? (linear ? 0 : 1) : (linear ? 3 : 2))}
                    }, false)
                }
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
