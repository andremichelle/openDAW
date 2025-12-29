import {Events} from "@opendaw/lib-dom"
import {StudioPreferences, TimelineRange} from "@opendaw/studio-core"

export namespace WheelScaling {
    export const install = (element: Element, range: TimelineRange) => {
        return Events.subscribe(element, "wheel", (event: WheelEvent) => {
            event.preventDefault()
            const scale = StudioPreferences.settings["normalize-mouse-wheel"]
                ? Math.sign(event.deltaY) * 0.025
                : event.deltaY * 0.01
            const rect = element.getBoundingClientRect()
            range.scaleBy(scale, range.xToValue(event.clientX - rect.left))
        }, {passive: false})
    }
}