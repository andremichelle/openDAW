import {Events} from "@opendaw/lib-dom"
import {TimelineRange} from "@opendaw/studio-core"
import {WheelScaling} from "@/ui/timeline/WheelScaling"

export const attachWheelScroll = (element: Element, range: TimelineRange) =>
    Events.subscribe(element, "wheel", (event: WheelEvent) => {
        if (event.shiftKey) {
            event.preventDefault()
            event.stopPropagation()
            WheelScaling.apply(element, range, event)
            return
        }
        const deltaX = event.deltaX
        const ratio = 0.0001
        const threshold = 1.0
        const clamped = Math.max(deltaX - threshold, 0.0) + Math.min(deltaX + threshold, 0.0)
        if (Math.abs(clamped) > 0) {
            event.preventDefault()
            range.moveBy(clamped * ratio)
        }
    }, {passive: false})
