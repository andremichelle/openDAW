import {Terminable} from "@opendaw/lib-std"
import type {TimelineRange} from "@opendaw/studio-core"
import type {Snapping} from "@/ui/timeline/Snapping"
import {installTimelineClickSeeking} from "@/ui/timeline/TimelineClickSeeking"

// The editor body includes a left header. Align navigation with the ruler's time surface,
// so keys, labels and parameter controls never become transport targets.
export const installEditorClickSeeking = (body: HTMLElement, axis: HTMLElement, range: TimelineRange,
                                    snapping: Snapping, enabled: () => boolean,
                                    seek: (position: number) => void, canSeek: () => boolean = () => true): Terminable =>
    installTimelineClickSeeking(body, x => {
        if (!enabled()) {return}
        const bounds = axis.getBoundingClientRect()
        const localX = x + body.getBoundingClientRect().left - bounds.left
        if (localX < 0 || localX >= bounds.width) {return}
        seek(snapping.round(Math.max(0, range.xToUnit(localX))))
    }, canSeek)
