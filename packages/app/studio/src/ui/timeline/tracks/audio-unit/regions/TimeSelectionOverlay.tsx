import css from "./TimeSelectionOverlay.sass?inline"
import {isDefined, Lifecycle, ObservableOption} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {deferNextFrame, Events, Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {TimelineRange} from "@opendaw/studio-core"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {TimeSelection} from "@/ui/timeline/TimeSelection"

const className = Html.adoptStyleSheet(css, "TimeSelectionOverlay")

type Construct = {
    lifecycle: Lifecycle
    manager: TracksManager
    range: TimelineRange
    scrollContainer: HTMLElement
    selection: ObservableOption<TimeSelection>
}

export const TimeSelectionOverlay = ({lifecycle, manager, range, scrollContainer, selection}: Construct) => {
    const rect: SVGRectElement = (
        <rect x="0" y="0" width="0" height="0"
              stroke={Colors.green}
              fill={Colors.green}
              fill-opacity={0.08}
              stroke-width={1}
              stroke-dasharray="4 3"/>
    )
    const svg: SVGSVGElement = <svg classList={className}>{rect}</svg>
    const setHidden = (hidden: boolean): void => {
        if (svg.classList.contains("hidden") !== hidden) {svg.classList.toggle("hidden", hidden)}
    }
    const update = (): void => {
        if (selection.isEmpty()) {
            setHidden(true)
            return
        }
        const {position, complete, rows, global} = selection.unwrap()
        const covered = manager.timeRows().filter(({key}) => rows.hasKey(key))
        const first = covered.at(0)
        const last = covered.at(-1)
        if (!global && !isDefined(first)) {
            setHidden(true)
            return
        }
        setHidden(false)
        const svgTop = svg.getBoundingClientRect().top
        const top = global || !isDefined(first) ? 0 : first.element.getBoundingClientRect().top - svgTop
        const bottom = global || !isDefined(last) ? svg.clientHeight : last.element.getBoundingClientRect().bottom - svgTop
        const x0 = Math.floor(range.unitToX(position)) + 0.5
        const x1 = Math.floor(range.unitToX(complete)) + 0.5
        rect.x.baseVal.value = x0
        rect.y.baseVal.value = top + 0.5
        rect.width.baseVal.value = Math.max(x1 - x0, 1)
        rect.height.baseVal.value = Math.max(bottom - top - 1, 1)
    }
    const {request} = lifecycle.own(deferNextFrame(update))
    const layoutObserver = new MutationObserver(request)
    layoutObserver.observe(scrollContainer, {childList: true, subtree: true, attributes: true, attributeFilter: ["class"]})
    lifecycle.ownAll(
        selection.subscribe(update),
        range.subscribe(update),
        Events.subscribe(scrollContainer, "scroll", update),
        Html.watchResize(svg, update),
        {terminate: () => layoutObserver.disconnect()}
    )
    update()
    return svg
}
