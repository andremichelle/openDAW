import {isDefined} from "@opendaw/lib-std"
import {TracksManager} from "./TracksManager"
import {Rect} from "@/ui/tour/TourPlacement"

// The row of the first track inside an area, or one default lane height when there are no tracks.
export const firstTrackRect = (area: HTMLElement, manager: TracksManager): Rect => {
    const {x, y, width} = area.getBoundingClientRect()
    const first = manager.tracks().at(0)
    if (isDefined(first)) {
        const {y: trackY, height} = first.element.getBoundingClientRect()
        return {x, y: trackY, width, height}
    }
    const style = getComputedStyle(area)
    const rootFontSize = parseFloat(getComputedStyle(area.ownerDocument.documentElement).fontSize)
    return {x, y, width, height: parseFloat(style.getPropertyValue("--lane-height")) * rootFontSize}
}
