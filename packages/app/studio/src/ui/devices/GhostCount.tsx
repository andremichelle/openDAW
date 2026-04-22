import css from "./GhostCount.sass?inline"
import {Color} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "GhostCount")

type Construct = {
    count: number
    color: Color
}

export const GhostCount = ({count, color}: Construct): HTMLElement => (
    <div className={className}>
        <div className="badge" style={{backgroundColor: color.toString()}}>{count}</div>
    </div>
)
