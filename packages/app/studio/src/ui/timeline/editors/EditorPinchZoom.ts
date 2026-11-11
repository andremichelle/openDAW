import {Events} from "@opendaw/lib-dom"
import type {TimelineRange} from "@opendaw/studio-core"
import {WheelScaling} from "@/ui/timeline/WheelScaling"

export const installEditorPinchZoom = (body: HTMLElement, axis: HTMLElement, range: TimelineRange,
                                       enabled: () => boolean) =>
    Events.subscribe(body, "wheel", (event: WheelEvent) => {
        if (!event.ctrlKey || !enabled()) {return}
        const bounds = axis.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX >= bounds.right) {return}
        // Capture before the pitch editor consumes vertical scrolling or audio sub-lanes zoom.
        event.preventDefault()
        event.stopPropagation()
        WheelScaling.apply(axis, range, event)
    }, {capture: true, passive: false})
