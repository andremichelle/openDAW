import {clamp, Lifecycle, Option} from "@opendaw/lib-std"
import {Dragging, Events} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {TrackHeaderClassName} from "./TrackStyles"

// A zero height preserves the theme's default for existing projects.
export const installTrackResize = (lifecycle: Lifecycle, service: StudioService,
                                   adapter: TrackBoxAdapter, element: HTMLElement): void => {
    const resizer: HTMLElement = <div className="track-resizer" title="Drag to resize track; double-click to reset"/>
    // Keep the resize hit area inside the left header, clear of clips and waveforms.
    const header = element.querySelector<HTMLElement>(`.${TrackHeaderClassName}`)!
    header.appendChild(resizer)
    const {height} = adapter.box
    const {editing} = service.project
    lifecycle.ownAll(
        height.catchupAndSubscribe(owner => {
            const value = owner.getValue()
            if (value === 0) {element.style.removeProperty("height")} else {element.style.height = `${value}px`}
        }),
        Dragging.attach(resizer, event => {
            event.stopPropagation()
            const original = height.getValue()
            const startHeight = element.getBoundingClientRect().height
            const startY = event.clientY
            const minimum = parseFloat(getComputedStyle(element).getPropertyValue("--lane-height"))
                * parseFloat(getComputedStyle(document.documentElement).fontSize)
            return Option.wrap({
                update: ({clientY}) => editing.modify(() =>
                    height.setValue(clamp(Math.round(startHeight + clientY - startY), Math.ceil(minimum), 480)), false),
                approve: () => editing.mark(),
                cancel: () => editing.modify(() => height.setValue(original), false)
            } satisfies Dragging.Process)
        }),
        Events.subscribe(resizer, "dblclick", event => {
            event.stopPropagation()
            editing.modify(() => height.setValue(0))
        }),
        Events.subscribe(header, "dblclick", event => {
            // Only the header background is empty space; preserve child controls and label editing.
            if (event.target !== header) {return}
            event.stopPropagation()
            editing.modify(() => height.setValue(0))
        })
    )
}
