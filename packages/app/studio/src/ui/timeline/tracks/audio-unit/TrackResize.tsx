import {asDefined, clamp, Lifecycle, Option} from "@opendaw/lib-std"
import {Dragging, Events} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {TrackHeaderClassName} from "./TrackStyles"

export const installTrackResize = (lifecycle: Lifecycle, service: StudioService,
                                   adapter: TrackBoxAdapter, element: HTMLElement): void => {
    const resizer: HTMLElement = <div className="track-resizer" title="Drag to resize track; double-click to reset"/>
    const header = asDefined(element.querySelector<HTMLElement>(`.${TrackHeaderClassName}`))
    header.appendChild(resizer)
    const {height} = adapter.box
    const {editing} = service.project
    lifecycle.ownAll(
        height.catchupAndSubscribe(owner => {
            const value = owner.getValue()
            if (value === 0) {element.style.removeProperty("height")} else {element.style.height = `${value}px`}
        }),
        Dragging.attach(resizer, event => {
            const constraints = height.constraints
            if (typeof constraints !== "object" || !("max" in constraints)) {return Option.None}
            event.stopPropagation()
            const original = height.getValue()
            const startHeight = element.getBoundingClientRect().height
            const startY = event.clientY
            const minimum = parseFloat(getComputedStyle(element).getPropertyValue("--lane-height"))
                * parseFloat(getComputedStyle(document.documentElement).fontSize)
            return Option.wrap({
                update: ({clientY}) => editing.modify(() =>
                    height.setValue(clamp(Math.round(startHeight + clientY - startY), Math.ceil(minimum), constraints.max)), false),
                approve: () => editing.mark(),
                cancel: () => editing.modify(() => height.setValue(original), false)
            } satisfies Dragging.Process)
        }),
        Events.subscribe(resizer, "dblclick", event => {
            event.stopPropagation()
            editing.modify(() => height.setValue(0))
        }),
        Events.subscribe(header, "dblclick", event => {
            if (event.target !== header) {return}
            event.stopPropagation()
            editing.modify(() => height.setValue(0))
        })
    )
}
