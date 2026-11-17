import {Events} from "@opendaw/lib-dom"
import {TimelineRange} from "@opendaw/studio-core"
import {WheelScaling} from "@/ui/timeline/WheelScaling"
import {WheelAxis} from "@/ui/timeline/WheelAxis"

export const moveByWheelPixels = (range: TimelineRange, event: WheelEvent): void =>
    range.moveUnitBy(WheelScaling.pixelsOf(event) * range.unitsPerPixel)

export const attachWheelScroll = (element: Element, range: TimelineRange) =>
    Events.subscribe(element, "wheel", (event: WheelEvent) => {
        if (event.ctrlKey || event.shiftKey) {
            event.preventDefault()
            event.stopPropagation()
            WheelScaling.apply(element, range, event)
            return
        }
        if (event.altKey) {
            event.preventDefault()
            event.stopPropagation()
            moveByWheelPixels(range, event)
            return
        }
        if (WheelAxis.of(event) === "horizontal") {
            event.preventDefault()
            range.moveBy(event.deltaX * 0.0001)
        }
    }, {passive: false})
