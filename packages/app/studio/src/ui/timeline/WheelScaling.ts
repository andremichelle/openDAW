import {Events} from "@moises-ai/lib-dom"
import {StudioPreferences, TimelineRange} from "@moises-ai/studio-core"

export namespace WheelScaling {
    export const install = (element: Element, range: TimelineRange) =>
        Events.subscribe(element, "wheel", (event: WheelEvent) => {
            event.preventDefault()
            const scale = StudioPreferences.settings.pointer["normalize-mouse-wheel"]
                ? Math.sign(event.deltaY) * 0.1
                : event.deltaY * 0.01
            const rect = element.getBoundingClientRect()
            range.scaleBy(scale, range.xToValue(event.clientX - rect.left))
        }, {passive: false})
}