import {asDefined, clamp, Lifecycle, Option} from "@opendaw/lib-std"
import {AnimationFrame, Dragging, Events} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"
import {MaxTrackHeight} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {TrackHeaderClassName} from "./TrackStyles"
import {TracksManager} from "./TracksManager"

const AutoScrollPadding = 24
const AutoScrollSpeed = 6.0 // px/s per px of depth into the padding

export const installTrackResize = (lifecycle: Lifecycle, service: StudioService, trackManager: TracksManager,
                                   adapter: TrackBoxAdapter, element: HTMLElement): void => {
    const resizer: HTMLElement = <div className="track-resizer" title="Drag to resize track; double-click to reset"/>
    const header = asDefined(element.querySelector<HTMLElement>(`.${TrackHeaderClassName}`))
    header.appendChild(resizer)
    const {height} = adapter.box
    const {editing} = service.project
    const {scrollableContainer, scrollModel} = trackManager
    const reset = () => {if (height.getValue() !== 0) {editing.modify(() => height.setValue(0))}}
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
            const startScroll = scrollModel.position
            const viewport = asDefined(scrollableContainer.parentElement, "no viewport")
            const minimum = Math.ceil(parseFloat(getComputedStyle(header).gridTemplateRows))
            let pointerY = event.clientY
            const apply = () => {
                const value = clamp(Math.round(startHeight + pointerY - startY + scrollModel.position - startScroll),
                    minimum, MaxTrackHeight)
                if (value !== height.getValue()) {editing.modify(() => height.setValue(value), false)}
            }
            let lastTime = performance.now()
            let carry = 0.0
            const autoScroll = AnimationFrame.add(() => {
                const now = performance.now()
                const elapsed = Math.min(now - lastTime, 100.0) / 1000.0
                lastTime = now
                const {top, bottom} = viewport.getBoundingClientRect()
                const depth = pointerY > bottom - AutoScrollPadding ? pointerY - (bottom - AutoScrollPadding)
                    : pointerY < top + AutoScrollPadding ? pointerY - (top + AutoScrollPadding) : 0
                if (depth === 0 || (depth > 0 && height.getValue() >= MaxTrackHeight)
                    || (depth < 0 && element.getBoundingClientRect().height <= minimum)) {
                    carry = 0.0
                    return
                }
                carry += clamp(depth, -AutoScrollPadding * 2, AutoScrollPadding * 2) * AutoScrollSpeed * elapsed
                const step = Math.trunc(carry)
                if (step === 0) {return}
                carry -= step
                scrollModel.position += step
                apply()
            })
            return Option.wrap({
                update: ({clientY}) => {
                    pointerY = clientY
                    apply()
                },
                approve: () => editing.mark(),
                cancel: () => editing.modify(() => height.setValue(original), false),
                finally: () => autoScroll.terminate()
            } satisfies Dragging.Process)
        }),
        Events.subscribe(resizer, "dblclick", event => {
            event.stopPropagation()
            reset()
        }),
        Events.subscribe(header, "dblclick", event => {
            if (event.target !== header) {return}
            event.stopPropagation()
            reset()
        })
    )
}
