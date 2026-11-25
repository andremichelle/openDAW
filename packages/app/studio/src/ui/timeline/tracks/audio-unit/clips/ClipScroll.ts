import {clamp, Lifecycle} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {ClipWidth} from "./constants"

export const clipScrollPosition = (position: number, columns: number, width: number): number =>
    clamp(position, 0, Math.max(0, columns * ClipWidth - 1 - width))

export const installClipScroll = (lifecycle: Lifecycle, service: StudioService, element: HTMLElement): void => {
    const clips = service.timeline.clips
    const constrain = () => clips.scroll.setValue(clipScrollPosition(
        clips.scroll.getValue(), Math.max(clips.columns.getValue(), clips.count.getValue()), element.clientWidth))
    lifecycle.ownAll(
        Html.watchResize(element, constrain),
        Events.subscribe(element, "wheel", (event: WheelEvent) => {
            if (event.ctrlKey || (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY))) {return}
            event.preventDefault()
            event.stopPropagation()
            const delta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
            const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1)
            clips.scroll.setValue(clipScrollPosition(clips.scroll.getValue() + pixels,
                Math.max(clips.columns.getValue(), clips.count.getValue()), element.clientWidth))
        }, {passive: false})
    )
}
