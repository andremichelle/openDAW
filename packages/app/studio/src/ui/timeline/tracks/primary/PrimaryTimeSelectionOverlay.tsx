import {Lifecycle, ObservableOption} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {TimelineRange} from "@opendaw/studio-core"
import {TimeSelection} from "@/ui/timeline/TimeSelection"

type Construct = {
    lifecycle: Lifecycle
    range: TimelineRange
    selection: ObservableOption<TimeSelection>
}

export const PrimaryTimeSelectionOverlay = ({lifecycle, range, selection}: Construct) => {
    const rect: SVGRectElement = (
        <rect x="0" y="0" width="0" height="0"
              stroke={Colors.green}
              fill={Colors.green}
              fill-opacity={0.08}
              stroke-width={1}
              stroke-dasharray="4 3"/>
    )
    const svg: SVGSVGElement = <svg width="100%" height="100%">{rect}</svg>
    const update = (): void => {
        if (selection.isEmpty() || !selection.unwrap().global) {
            svg.classList.add("hidden")
            return
        }
        svg.classList.remove("hidden")
        const {position, complete} = selection.unwrap()
        const x0 = Math.floor(range.unitToX(position)) + 0.5
        const x1 = Math.floor(range.unitToX(complete)) + 0.5
        rect.x.baseVal.value = x0
        rect.y.baseVal.value = 0.5
        rect.width.baseVal.value = Math.max(x1 - x0, 1)
        rect.height.baseVal.value = Math.max(svg.clientHeight - 1, 1)
    }
    lifecycle.ownAll(selection.subscribe(update), range.subscribe(update), Html.watchResize(svg, update))
    update()
    return svg
}
