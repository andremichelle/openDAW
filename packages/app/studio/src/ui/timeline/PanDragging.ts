import {Subscription, Terminator} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {WheelScaling} from "@/ui/timeline/WheelScaling"

export namespace PanDragging {
    export const install = (element: EventTarget, pan: (deltaX: number, deltaY: number) => void): Subscription =>
        Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
            if (event.button !== 1 || !WheelScaling.isFlStudioMode()) {return}
            event.preventDefault()
            event.stopPropagation()
            let lastX = event.clientX, lastY = event.clientY
            const gesture = new Terminator()
            gesture.ownAll(
                Events.subscribe(window, "pointermove", (move: PointerEvent) => {
                    pan(move.clientX - lastX, move.clientY - lastY)
                    lastX = move.clientX
                    lastY = move.clientY
                }),
                Events.subscribe(window, "pointerup", () => gesture.terminate()),
                Events.subscribe(window, "pointercancel", () => gesture.terminate())
            )
        }, {capture: true})
}
