import css from "./CutCursor.sass?inline"
import {isDefined, Lifecycle, Nullable, ObservableValue} from "@moises-ai/lib-std"
import {ppqn} from "@moises-ai/lib-dsp"
import {TimelineRange} from "@moises-ai/studio-core"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "CutCursor")

type Construct = {
    lifecycle: Lifecycle
    range: TimelineRange
    position: ObservableValue<Nullable<ppqn>>
}

export const CutCursor = ({lifecycle, range, position}: Construct) => {
    const svg: SVGSVGElement = (
        <svg classList={className}>
            <line x1="0" y1="0" x2="0" y2="100%"
                  stroke="rgba(255,255,255,0.5)"
                  stroke-width="1"
                  stroke-dasharray="1,2"/>
        </svg>
    )
    const updater = () => {
        const value = position.getValue()
        if (isDefined(value)) {
            svg.style.left = `${Math.floor(range.unitToX(Math.max(value, 0))) + 1}px`
            svg.style.display = "block"
        } else {
            svg.style.display = "none"
        }
    }
    lifecycle.ownAll(position.subscribe(updater), Html.watchResize(svg, updater))
    updater()
    return svg
}